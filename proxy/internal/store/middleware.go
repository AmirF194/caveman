package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Middleware state lives beside the existing replacement cache. Unlike its LRU,
// live middleware leases are never evicted: capacity stops new plans. CCR owns
// originals; these tables own scoped grants, immutable choices and observations.
const middlewareSchema = `
CREATE TABLE IF NOT EXISTS middleware_scopes (
  id TEXT PRIMARY KEY, authority TEXT NOT NULL, manifest BLOB NOT NULL,
  sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS middleware_choices (
  scope TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL,
  grant_id TEXT NOT NULL UNIQUE, ccr_handle TEXT NOT NULL,
  PRIMARY KEY(scope,id)
);
CREATE INDEX IF NOT EXISTS middleware_scopes_authority ON middleware_scopes(authority);
CREATE INDEX IF NOT EXISTS middleware_scopes_expiry ON middleware_scopes(expires_at);
CREATE TABLE IF NOT EXISTS middleware_plans (
  scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
  payload BLOB NOT NULL, PRIMARY KEY(scope,id)
);
CREATE TABLE IF NOT EXISTS middleware_receipts (
  authority TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
  payload BLOB NOT NULL, PRIMARY KEY(authority,id)
);
CREATE TABLE IF NOT EXISTS middleware_originals (
  authority TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(authority,digest)
);
CREATE TABLE IF NOT EXISTS middleware_usage (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL
);`

var (
	ErrMiddlewareConflict = errors.New("middleware: identity conflict")
	ErrMiddlewareCapacity = errors.New("middleware: capacity")
)

func (s *Store) InitMiddleware(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, middlewareSchema); err != nil {
		return err
	}
	// Backfill only at migration time. Trigger-maintained counters make each
	// admission O(1), including writes by another process using this store.
	if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO middleware_usage SELECT 1,
 (SELECT count(*) FROM middleware_scopes)+(SELECT count(*) FROM middleware_choices)+
 (SELECT count(*) FROM middleware_plans)+(SELECT count(*) FROM middleware_receipts)+(SELECT count(*) FROM middleware_originals),
 coalesce((SELECT sum(length(payload)) FROM middleware_choices),0)+coalesce((SELECT sum(length(payload)) FROM middleware_plans),0)+
 coalesce((SELECT sum(length(payload)) FROM middleware_receipts),0)+coalesce((SELECT sum(length(manifest)) FROM middleware_scopes),0)+
 (SELECT count(*)*64 FROM middleware_originals) WHERE NOT EXISTS(SELECT 1 FROM middleware_usage)`); err != nil {
		return err
	}
	for _, table := range []struct{ name, size string }{
		{"middleware_scopes", "length(manifest)"}, {"middleware_choices", "length(payload)"},
		{"middleware_plans", "length(payload)"}, {"middleware_receipts", "length(payload)"}, {"middleware_originals", "64"},
	} {
		newSize, oldSize := "64", "64"
		if table.size != "64" {
			newSize = "length(NEW." + table.size[7:len(table.size)-1] + ")"
			oldSize = "length(OLD." + table.size[7:len(table.size)-1] + ")"
		}
		statements := fmt.Sprintf(`
CREATE TRIGGER IF NOT EXISTS %[1]s_usage_insert AFTER INSERT ON %[1]s BEGIN UPDATE middleware_usage SET rows=rows+1,bytes=bytes+%[2]s WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS %[1]s_usage_delete AFTER DELETE ON %[1]s BEGIN UPDATE middleware_usage SET rows=rows-1,bytes=bytes-%[3]s WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS %[1]s_usage_update AFTER UPDATE ON %[1]s BEGIN UPDATE middleware_usage SET bytes=bytes+%[2]s-%[3]s WHERE singleton=1; END;`, table.name, newSize, oldSize)
		if _, err = tx.ExecContext(ctx, statements); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type MiddlewareScope struct {
	ID, Authority       string
	Manifest            []byte
	Sequence, ExpiresAt int64
}

// MiddlewareTx serializes decisions across processes, not just Go goroutines.
// Its first statement takes SQLite's write lock before any decision is read.
type MiddlewareTx struct {
	tx  *sql.Tx
	ctx context.Context
}

// ReadMiddleware takes a consistent snapshot without reserving SQLite's writer.
// Callers must recheck every decision under WithMiddleware before publishing it.
func (s *Store) ReadMiddleware(ctx context.Context, fn func(*MiddlewareTx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(&MiddlewareTx{tx: tx, ctx: ctx}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) WithMiddleware(ctx context.Context, fn func(*MiddlewareTx) error) error {
	// Avoid SQLite's busy-handler sleep/backoff between local requests. This
	// queue is cancellable; SQLite still arbitrates against other processes.
	select {
	case s.middlewareWriter <- struct{}{}:
		defer func() { <-s.middlewareWriter }()
	case <-ctx.Done():
		return ctx.Err()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE middleware_scopes SET sequence=sequence WHERE id=''`); err != nil {
		return err
	}
	if err = fn(&MiddlewareTx{tx: tx, ctx: ctx}); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return tx.Commit()
}

func (t *MiddlewareTx) Scope(id string) (MiddlewareScope, error) {
	s := MiddlewareScope{ID: id}
	err := t.tx.QueryRowContext(t.ctx, `SELECT authority,manifest,sequence,expires_at FROM middleware_scopes WHERE id=?`, id).
		Scan(&s.Authority, &s.Manifest, &s.Sequence, &s.ExpiresAt)
	return s, err
}

func (t *MiddlewareTx) SaveScope(s MiddlewareScope) error {
	var old int
	err := t.tx.QueryRowContext(t.ctx, `SELECT length(manifest) FROM middleware_scopes WHERE id=?`, s.ID).Scan(&old)
	rows := 0
	if errors.Is(err, sql.ErrNoRows) {
		rows = 1
	} else if err != nil {
		return err
	}
	if err := t.capacity(len(s.Manifest)-old, rows); err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO middleware_scopes VALUES (?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,sequence=excluded.sequence,expires_at=excluded.expires_at`,
		s.ID, s.Authority, s.Manifest, s.Sequence, s.ExpiresAt)
	return err
}

func (t *MiddlewareTx) Plan(scope, id, digest string) ([]byte, error) {
	var storedDigest string
	var body []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT digest,payload FROM middleware_plans WHERE scope=? AND id=?`, scope, id).Scan(&storedDigest, &body)
	if err == nil && storedDigest != digest {
		return nil, ErrMiddlewareConflict
	}
	return body, err
}

func (t *MiddlewareTx) SavePlan(scope, id, digest string, body []byte) error {
	if err := t.capacity(len(body), 1); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO middleware_plans VALUES (?,?,?,?)`, scope, id, digest, body)
	return err
}

func (t *MiddlewareTx) Choice(scope, id string) ([]byte, string, error) {
	var body []byte
	var handle string
	err := t.tx.QueryRowContext(t.ctx, `SELECT payload,ccr_handle FROM middleware_choices WHERE scope=? AND id=?`, scope, id).Scan(&body, &handle)
	return body, handle, err
}

func (t *MiddlewareTx) SaveChoice(scope, id, grant, handle string, body []byte) error {
	if err := t.capacity(len(body), 1); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO middleware_choices VALUES (?,?,?,?,?)`, scope, id, body, grant, handle)
	return err
}

// Grant never accepts a global CCR hash as authority. Even possession of the
// random grant requires the authenticated principal and matching session scope.
func (t *MiddlewareTx) Grant(authority, grant string) ([]byte, string, int64, error) {
	var body []byte
	var handle string
	var expires int64
	err := t.tx.QueryRowContext(t.ctx, `SELECT c.payload,c.ccr_handle,s.expires_at
FROM middleware_choices c JOIN middleware_scopes s ON c.scope=s.id
WHERE s.authority=? AND c.grant_id=?`, authority, grant).Scan(&body, &handle, &expires)
	return body, handle, expires, err
}

func (t *MiddlewareTx) Renew(authority string, now, expires int64) error {
	_, err := t.tx.ExecContext(t.ctx, `UPDATE middleware_scopes SET expires_at=? WHERE authority=? AND expires_at>?`, expires, authority, now)
	return err
}

func (t *MiddlewareTx) Delete(authority string) error {
	// Retain bounded metadata tombstones, not replacement text. Old markers
	// still return a typed revoked result; no epoch silently resumes old grants.
	if _, err := t.tx.ExecContext(t.ctx, `UPDATE middleware_scopes SET expires_at=0 WHERE authority=?`, authority); err != nil {
		return err
	}
	return t.purge(`SELECT id FROM middleware_scopes WHERE authority=?`, authority)
}

// Expire removes payloads from a bounded batch of expired sessions. Original
// storage is owned by CCR; this operation revokes access, not global originals.
func (t *MiddlewareTx) Expire(now int64) error {
	return t.purge(`SELECT id FROM middleware_scopes WHERE expires_at<=? AND length(manifest)>0 LIMIT 128`, now)
}

func (t *MiddlewareTx) purge(selection string, argument any) error {
	// Clear manifests last, since Expire uses them to select unprocessed rows.
	for _, statement := range []string{
		`DELETE FROM middleware_plans WHERE scope IN (` + selection + `)`,
		`UPDATE middleware_choices SET payload=x'',ccr_handle='' WHERE scope IN (` + selection + `)`,
		`UPDATE middleware_scopes SET manifest=x'' WHERE id IN (` + selection + `)`,
	} {
		if _, err := t.tx.ExecContext(t.ctx, statement, argument); err != nil {
			return err
		}
	}
	return nil
}

// CreditOriginal counts identical content once inside an authenticated session
// scope, without merging document/source identities or their recovery grants.
func (t *MiddlewareTx) CreditOriginal(authority, digest string) (bool, error) {
	var exists int
	err := t.tx.QueryRowContext(t.ctx, `SELECT 1 FROM middleware_originals WHERE authority=? AND digest=?`, authority, digest).Scan(&exists)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if err = t.capacity(64, 1); err != nil {
		return false, err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO middleware_originals VALUES (?,?)`, authority, digest)
	return err == nil, err
}

func (t *MiddlewareTx) Receipt(authority, id, digest string, body []byte) error {
	var old string
	err := t.tx.QueryRowContext(t.ctx, `SELECT digest FROM middleware_receipts WHERE authority=? AND id=?`, authority, id).Scan(&old)
	if err == nil {
		if old != digest {
			return ErrMiddlewareConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := t.capacity(len(body), 1); err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO middleware_receipts VALUES (?,?,?,?)`, authority, id, digest, body)
	return err
}

func (t *MiddlewareTx) capacity(extra, rows int) error {
	var count, size int64
	err := t.tx.QueryRowContext(t.ctx, `SELECT rows,bytes FROM middleware_usage WHERE singleton=1`).Scan(&count, &size)
	if err != nil {
		return err
	}
	if count+int64(rows) > 100000 || size+int64(extra) > 64<<20 {
		return ErrMiddlewareCapacity
	}
	return nil
}
