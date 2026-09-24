package playback

import (
	"testing"
	"time"
)

func TestWeekdayKind(t *testing.T) {
	tests := []struct {
		day  time.Weekday
		want string
	}{
		{time.Monday, "weekday_mon"},
		{time.Tuesday, "weekday_tue"},
		{time.Wednesday, "weekday_wed"},
		{time.Thursday, "weekday_thu"},
		{time.Friday, "weekday_fri"},
		{time.Saturday, "weekday_sat"},
		{time.Sunday, "weekday_sun"},
	}
	for _, test := range tests {
		if got := WeekdayKind(test.day); got != test.want {
			t.Errorf("WeekdayKind(%s) = %q, want %q", test.day, got, test.want)
		}
	}
}
