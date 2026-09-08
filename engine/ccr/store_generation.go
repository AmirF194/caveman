//go:build !js

package ccr

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"modernc.org/sqlite"
)

// SQLite holds file descriptors across calls. A path can start naming a new
// database while an old descriptor still accepts writes to an unlinked inode.
// Track identity, not size/mtime: normal writes and WAL checkpoints change both.
type sqliteGeneration [3]os.FileInfo

var sqliteSuffixes = [...]string{"", "-wal", "-shm"}

func inspectSQLiteGeneration(path string) (sqliteGeneration, error) {
	var files sqliteGeneration
	if path == ":memory:" {
		return files, nil
	}
	parent := filepath.Dir(path)
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil || resolved != parent {
		return files, fmt.Errorf("%w: database parent changed", ErrStorageChanged)
	}
	info, err := os.Stat(parent)
	if err != nil {
		return files, fmt.Errorf("%w: inspect database parent: %v", ErrStorageChanged, err)
	}
	if err := validateSQLiteParentSecurity(parent, info); err != nil {
		return files, fmt.Errorf("%w: %v", ErrStorageChanged, err)
	}
	for i, suffix := range sqliteSuffixes {
		info, err := inspectSQLiteFile(path + suffix)
		if errors.Is(err, os.ErrNotExist) && i != 0 {
			continue
		}
		if err != nil {
			return files, fmt.Errorf("%w: inspect database%s: %v", ErrStorageChanged, suffix, err)
		}
		if !info.Mode().IsRegular() {
			return files, fmt.Errorf("%w: refusing non-regular database%s", ErrStorageChanged, suffix)
		}
		files[i] = info
	}
	return files, nil
}

func sameSQLiteFile(a, b os.FileInfo) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return os.SameFile(a, b)
}

// sameExisting also permits sidecars to be created while opening a clean DB.
func (a sqliteGeneration) sameExisting(b sqliteGeneration) bool {
	for i := range a {
		if a[i] != nil && !sameSQLiteFile(a[i], b[i]) {
			return false
		}
	}
	return true
}

func (a sqliteGeneration) same(b sqliteGeneration) bool {
	for i := range a {
		if !sameSQLiteFile(a[i], b[i]) {
			return false
		}
	}
	return true
}

// PERSIST_WAL prevents close from unlinking WAL/SHM by their original names.
// It DOES NOT prevent a final checkpoint. A changed generation is quarantined
// regardless of this flag; ordinary closes preserve the valid journal files.
func persistSQLiteWAL(db *sql.DB) error {
	conn, err := db.Conn(context.Background())
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Raw(func(raw any) error {
		control, ok := raw.(sqlite.FileControl)
		if !ok {
			return errors.New("sqlite driver lacks persistent journal control")
		}
		_, err := control.FileControlPersistWAL("main", 1)
		return err
	})
}

// A failed initialization may already hold journals whose paths were replaced
// before the first complete generation snapshot. Never close an opened disk
// connection on that error path: SQLite close can checkpoint its stale WAL into
// the current main file. The process must exit to release those descriptors.
func closeSQLiteAfterOpenFailure(db *sql.DB, path string) {
	if path == ":memory:" || db.Stats().OpenConnections == 0 {
		_ = db.Close()
	}
}

// checkGeneration runs with mu held. A detected generation change is terminal
// for this Store. A fresh process must open the restored/current database;
// pathname snapshots cannot establish which files a replacement connection
// actually opened, so automatically adopting a replacement is unsafe.
func (s *Store) checkGeneration() error {
	if s.quarantined != nil {
		return s.quarantined
	}
	if s.closed {
		return errors.New("ccr: recovery store is closed")
	}
	files, err := inspectSQLiteGeneration(s.path)
	if err != nil {
		s.quarantined = err
		return s.quarantined
	}
	if s.db != nil && s.files.same(files) {
		return nil
	}
	// No SQLite calls, including Close, follow invalidation. The public driver
	// exposes no descriptor identity or NO_CKPT_ON_CLOSE control. Keeping this
	// one connection until exit avoids replaying its obsolete journal.
	s.quarantined = fmt.Errorf("%w: database or journal removed or replaced; connection quarantined until process exit", ErrStorageChanged)
	return s.quarantined
}

func withStore[T any](s *Store, fn func() (T, error)) (T, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var zero T
	if err := s.checkGeneration(); err != nil {
		return zero, err
	}
	value, err := fn()
	if changed := s.checkGeneration(); changed != nil {
		return zero, changed
	}
	return value, err
}

// Close releases a valid connection. A quarantined connection is deliberately
// retained until process exit: SQLite close could replay its obsolete journal.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	if s.quarantined != nil {
		return s.quarantined
	}
	if s.db == nil {
		s.closed = true
		return nil
	}
	if err := s.checkGeneration(); err != nil {
		return err
	}
	if s.path != ":memory:" {
		if err := persistSQLiteWAL(s.db); err != nil {
			return err
		}
	}
	err := s.db.Close()
	s.closed = true
	return err
}

func (s *Store) Put(rec Recovery) (string, error) {
	return withStore(s, func() (string, error) { return s.put(rec) })
}

func (s *Store) Get(handle string) ([]byte, error) {
	return withStore(s, func() ([]byte, error) { return s.get(handle) })
}

func (s *Store) GetMetadata(handle string) ([]byte, error) {
	return withStore(s, func() ([]byte, error) { return s.getMetadata(handle) })
}

func (s *Store) PutObject(obj Object) (string, error) {
	return withStore(s, func() (string, error) { return s.putObject(obj) })
}

func (s *Store) GetObject(id string) (Object, error) {
	return withStore(s, func() (Object, error) { return s.getObject(id) })
}

func (s *Store) SetObjectCurrentness(id string, value Currentness) error {
	_, err := withStore(s, func() (struct{}, error) { return struct{}{}, s.setObjectCurrentness(id, value) })
	return err
}

func (s *Store) SetObjectLifecycle(id string, value Lifecycle) error {
	_, err := withStore(s, func() (struct{}, error) { return struct{}{}, s.setObjectLifecycle(id, value) })
	return err
}

func (s *Store) ListSessionObjects(sessionID string, limit int) ([]Object, error) {
	return withStore(s, func() ([]Object, error) { return s.listSessionObjects(sessionID, limit) })
}

func (s *Store) FindTaskDecision(id string) (Object, error) {
	return withStore(s, func() (Object, error) { return s.findTaskDecision(id) })
}

func (s *Store) Summary() (Stats, error) {
	return withStore(s, s.summary)
}
