package playback

// StartShare creates and initializes a session for a shared radio stream.
func (e *Engine) StartShare() *Session {
	sess := e.NewSession("share")
	sess.Lock()
	startID := e.PickStart(sess, nil)
	sess.Current = startID
	e.ExcludeTrack(sess, startID)
	e.RefreshQueue(sess, startID, false)
	sess.Unlock()
	return sess
}

// ShareCurrentTrackID returns the current track while preserving session locking.
func (e *Engine) ShareCurrentTrackID(sess *Session) int64 {
	if sess == nil {
		return 0
	}
	sess.Lock()
	defer sess.Unlock()
	return sess.Current
}

// AdvanceShare advances a shared radio session and restarts its queue when needed.
func (e *Engine) AdvanceShare(sess *Session) int64 {
	if sess == nil {
		return 0
	}
	sess.Lock()
	defer sess.Unlock()

	if next := e.Advance(sess); next != 0 {
		return next
	}
	next := e.PickStart(sess, nil)
	if next == 0 {
		return 0
	}
	sess.Mode = "share"
	sess.Current = next
	e.ExcludeTrack(sess, next)
	e.RefreshQueue(sess, next, false)
	return next
}
