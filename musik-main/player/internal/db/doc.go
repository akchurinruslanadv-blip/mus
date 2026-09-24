// Package db is the player's SQLite store. Files are split by table/concern:
//
//	store.go      Open, schema, Store
//	tracks.go     catalog rows and paths
//	history.go    listens, transitions, rec_stats, impressions
//	profile.go    taste snapshots and top artists/clusters
//	playlists.go  generated mixes, later, favorites
//	jobs.go       worker job queue
//	metrics.go    weekly recommendation metrics
//	radio.go      public radio share tokens
//	sessions.go   persisted play sessions
//	lyrics.go     lyrics rows
package db
