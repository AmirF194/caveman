package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestMiddlewareQuotaCountersPersistAndRollback(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "store.db")
	s, err := Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.InitMiddleware(ctx); err != nil {
		t.Fatal(err)
	}
	err = s.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		if err := tx.SaveScope(MiddlewareScope{ID: "scope", Authority: "auth", Manifest: []byte("[]"), ExpiresAt: 100}); err != nil {
			return err
		}
		if err := tx.SaveChoice("scope", "choice", "grant", "ccr", make([]byte, 256)); err != nil {
			return err
		}
		if err := tx.SavePlan("scope", "plan", "hash", make([]byte, 128)); err != nil {
			return err
		}
		if err := tx.Receipt("auth", "receipt", "hash", make([]byte, 64)); err != nil {
			return err
		}
		credit, err := tx.CreditOriginal("auth", "original")
		if !credit {
			t.Error("first original was not credited")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	check := func(rows, size int) {
		t.Helper()
		var gotRows, gotSize int
		if err := s.db.QueryRow(`SELECT rows,bytes FROM middleware_usage`).Scan(&gotRows, &gotSize); err != nil {
			t.Fatal(err)
		}
		if gotRows != rows || gotSize != size {
			t.Fatalf("quota counters=(%d,%d), want (%d,%d)", gotRows, gotSize, rows, size)
		}
	}
	check(5, 514)
	abort := errors.New("rollback")
	if err := s.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		if err := tx.SaveChoice("scope", "other", "other-grant", "ccr", make([]byte, 32)); err != nil {
			return err
		}
		return abort
	}); !errors.Is(err, abort) {
		t.Fatal(err)
	}
	check(5, 514)
	other, err := Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := other.InitMiddleware(ctx); err != nil {
		t.Fatal(err)
	}
	if err := other.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		credit, err := tx.CreditOriginal("auth", "original")
		if credit {
			t.Error("reopened store credited the same content twice")
		}
		if err != nil {
			return err
		}
		return tx.SaveScope(MiddlewareScope{ID: "scope", Authority: "auth", Manifest: []byte("[1]"), ExpiresAt: 100})
	}); err != nil {
		t.Fatal(err)
	}
	check(5, 515)
	if err := s.WithMiddleware(ctx, func(tx *MiddlewareTx) error { return tx.Delete("auth") }); err != nil {
		t.Fatal(err)
	}
	check(4, 128) // scope/grant tombstones, receipt metadata, original credit.
	if err := s.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		body, handle, expiry, err := tx.Grant("auth", "grant")
		if err == nil && (len(body) != 0 || handle != "" || expiry != 0) {
			t.Fatal("revocation retained recoverable payload")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMiddlewareExpiryReclaimsPayloadAndKeepsTypedTombstone(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "store.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.InitMiddleware(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		if err := tx.SaveScope(MiddlewareScope{ID: "expired", Authority: "auth", Manifest: []byte("[]"), ExpiresAt: 10}); err != nil {
			return err
		}
		if err := tx.SaveChoice("expired", "choice", "grant", "ccr", []byte("replacement")); err != nil {
			return err
		}
		if err := tx.SavePlan("expired", "plan", "digest", []byte("plan")); err != nil {
			return err
		}
		return tx.Expire(11)
	}); err != nil {
		t.Fatal(err)
	}
	var size int
	if err := s.db.QueryRow(`SELECT bytes FROM middleware_usage`).Scan(&size); err != nil {
		t.Fatal(err)
	}
	if size != 0 {
		t.Fatalf("expired payload bytes=%d", size)
	}
	if err := s.WithMiddleware(ctx, func(tx *MiddlewareTx) error {
		_, _, expiry, err := tx.Grant("auth", "grant")
		if expiry != 10 {
			t.Errorf("expired grant lost expiry identity: %d", expiry)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
