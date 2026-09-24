package playback

import "time"

func WeekdayKind(day time.Weekday) string {
	switch day {
	case time.Monday:
		return "weekday_mon"
	case time.Tuesday:
		return "weekday_tue"
	case time.Wednesday:
		return "weekday_wed"
	case time.Thursday:
		return "weekday_thu"
	case time.Friday:
		return "weekday_fri"
	case time.Saturday:
		return "weekday_sat"
	default:
		return "weekday_sun"
	}
}

func TodayWeekdayKind() string {
	return WeekdayKind(time.Now().Weekday())
}
