// Package api is the HTTP layer of musik-player: routes, JSON, cookies, and
// request/response mapping. Application and domain work lives next door:
//
//	internal/app        reload lifecycle and worker coordination
//	internal/media      artwork, transcoding, and stream warming
//	internal/library    upload paths and artist/album grouping
//	internal/playback   sessions, radio/playlist queues, listen events
//	internal/recommend  similar tracks/artists/albums
//	internal/index      in-memory embeddings
//	internal/queue      radio scoring
//	internal/taste      EMA profile
//	internal/db         SQLite
//	internal/auth       password / Bearer / cookie
//
// Files here are named after the HTTP surface:
//
//	server.go     Server, New, route table
//	http.go       CORS, JSON helpers, static, health, PWA manifest
//	auth.go       login / logout / me
//	library.go    catalog list, reload
//	catalog.go    artists, albums, track JSON
//	upload.go     library upload
//	stream.go     original and mobile stream dispatch
//	artwork.go    covers
//	play.go       POST /api/play
//	session.go    session start/now/jump
//	events.go     listen events
//	radio.go      personal radio start
//	share.go      share-radio tokens
//	listen.go     public MP3 radio stream
//	mixes.go      mix shelf + play
//	later.go      later list
//	favorites.go  hearts
//	recommend.go  similar / seed / favorites mix
//	discover.go   album and resurfaced tips
//	jobs.go       worker job proxy
//	worker.go     worker autostart
//	metrics.go    weekly / recommendation stats
//	profile.go    taste snapshot
//	lyrics.go     track lyrics
//	openapi.go    embedded API document handler
//	latency.go    in-process endpoint latency summaries
//
// HTTP tests live in internal/apitest, not here.
package api
