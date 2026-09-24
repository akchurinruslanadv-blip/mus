package apitest

import (
	"encoding/json"
	"testing"

	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
)

func TestSessionStartNowAndEvents(t *testing.T) {
	server := openTestServer(t)

	rec := serve(server, jsonReq("POST", "/api/session/start", `{"seed_track_id":11}`))
	if rec.Code != 200 {
		t.Fatalf("session start status=%d body=%s", rec.Code, rec.Body.String())
	}
	var started struct {
		SessionID string `json:"session_id"`
		Current   struct {
			ID int64 `json:"id"`
		} `json:"current"`
		Queue []any `json:"queue"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.SessionID == "" || started.Current.ID != 11 {
		t.Fatalf("started=%+v", started)
	}
	flush(server)

	rec = serve(server, jsonReq("GET", "/api/now?session_id="+started.SessionID, ""))
	if rec.Code != 200 {
		t.Fatalf("now status=%d", rec.Code)
	}

	rec = serve(server, jsonReq("POST", "/api/events",
		`{"type":"like","track_id":11,"session_id":"`+started.SessionID+`"}`))
	if rec.Code != 200 {
		t.Fatalf("like status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = serve(server, jsonReq("POST", "/api/events",
		`{"type":"track_end","track_id":11,"session_id":"`+started.SessionID+`","duration_sec":180,"listened_sec":170,"reason":"completed"}`))
	if rec.Code != 200 {
		t.Fatalf("track_end status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ended struct {
		OK     bool  `json:"ok"`
		NextID int64 `json:"next_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ended); err != nil {
		t.Fatal(err)
	}
	if !ended.OK || ended.NextID == 0 {
		t.Fatalf("expected next track after end: %+v", ended)
	}
	flush(server)

	var listens int
	if err := server.Store.DB.QueryRow(`SELECT COUNT(*) FROM listening_history`).Scan(&listens); err != nil {
		t.Fatal(err)
	}
	if listens < 1 {
		t.Fatal("events should write listening history")
	}
}

func TestEventsRequireSession(t *testing.T) {
	server := openTestServer(t)
	rec := serve(server, jsonReq("POST", "/api/events", `{"type":"like","track_id":11}`))
	if rec.Code == 200 {
		t.Fatal("events without session should fail")
	}
}

func TestStatusIncludesSessionSnapshot(t *testing.T) {
	server := openTestServer(t)
	rec := serve(server, jsonReq("POST", "/api/radio/start", `{}`))
	var started struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	rec = serve(server, jsonReq("GET", "/api/status?session_id="+started.SessionID, ""))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["session_id"] != started.SessionID {
		t.Fatalf("status session snapshot missing: %#v", body)
	}
}

func TestRadioStartRecordsImpressions(t *testing.T) {
	server := openTestServer(t)
	loadIndex(t, server, []db.TrackRow{
		{ID: 1, Artist: "Massive Attack", Album: "Mezzanine", Title: "Angel", Embedding: index.Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 2, Artist: "Portishead", Album: "Dummy", Title: "Glory Box", Embedding: index.Float32Bytes([]float32{0.9, 0.1}), Dim: 2},
		{ID: 3, Artist: "Bjork", Album: "Homogenic", Title: "Joga", Embedding: index.Float32Bytes([]float32{0, 1}), Dim: 2},
	})

	rec := serve(server, jsonReq("POST", "/api/radio/start", `{}`))
	if rec.Code != 200 {
		t.Fatalf("radio status=%d body=%s", rec.Code, rec.Body.String())
	}
	flush(server)

	var n int
	if err := server.Store.DB.QueryRow(`SELECT COUNT(*) FROM recommendation_impressions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("radio queue refresh should persist recommendation impressions")
	}
}
