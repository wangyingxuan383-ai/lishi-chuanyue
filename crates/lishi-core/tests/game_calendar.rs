use lishi_core::game_calendar::*;
fn time(year: i32, month: u8, day: u8) -> CalendarDateTime {
    CalendarDateTime {
        date: CalendarDate {
            era_year: year,
            month,
            day,
        },
        hour: 0,
        minute: 0,
        second: 0,
    }
}
#[test]
fn bce_ce_boundary_has_no_public_year_zero() {
    let end = CalendarDateTime {
        date: CalendarDate {
            era_year: -1,
            month: 12,
            day: 31,
        },
        hour: 23,
        minute: 59,
        second: 59,
    };
    assert_eq!(advance_calendar_time(end, 1).unwrap(), time(1, 1, 1));
    assert_eq!(calendar_range(0, 0), Err(CalendarError::InvalidDate));
    assert_eq!(
        advance_calendar_time(time(0, 1, 1), 0),
        Err(CalendarError::InvalidDate)
    );
}
#[test]
fn gregorian_leap_centuries_and_bce_arithmetic_are_checked() {
    assert_eq!(
        advance_calendar_time(time(2000, 2, 28), 86_400).unwrap(),
        time(2000, 2, 29)
    );
    assert_eq!(
        advance_calendar_time(time(1900, 2, 28), 86_400).unwrap(),
        time(1900, 3, 1)
    );
    assert_eq!(
        advance_calendar_time(time(-1, 2, 28), 86_400).unwrap(),
        time(-1, 2, 29)
    );
    assert_eq!(
        advance_calendar_time(time(-2, 2, 29), 0),
        Err(CalendarError::InvalidDate)
    );
    assert_eq!(
        advance_calendar_time(time(1900, 2, 29), 0),
        Err(CalendarError::InvalidDate)
    );
    assert_eq!(
        advance_calendar_time(time(2000, 4, 31), 0),
        Err(CalendarError::InvalidDate)
    );
}
#[test]
fn year_only_opening_remains_a_range_after_cross_year_progress() {
    let origin = calendar_range(-1, 0).unwrap();
    assert_eq!(origin.earliest, time(-1, 1, 1));
    assert_eq!(
        origin.latest.date,
        CalendarDate {
            era_year: -1,
            month: 12,
            day: 31
        }
    );
    let shifted = calendar_range(-1, 366 * 86_400).unwrap();
    assert_eq!(shifted.earliest, time(1, 1, 1));
    assert_eq!(
        shifted.latest.date,
        CalendarDate {
            era_year: 2,
            month: 1,
            day: 1
        }
    );
    assert_ne!(shifted.earliest, shifted.latest);
    assert_eq!(
        calendar_range(999_999, 366 * 86_400),
        Err(CalendarError::OutOfRange)
    );
    assert_eq!(
        calendar_range(618, u64::MAX),
        Err(CalendarError::OutOfRange)
    );
}
#[test]
fn ten_year_progress_changes_known_age_without_changing_a_birth_date() {
    let birth = BirthDateRange {
        earliest: time(1970, 1, 1).date,
        latest: time(1970, 1, 1).date,
    };
    let first = time(2000, 1, 1);
    let later = advance_calendar_time(first, 3653 * 86_400).unwrap();
    assert_eq!(later, time(2010, 1, 1));
    let before = age_range(
        &CalendarRange {
            earliest: first,
            latest: first,
        },
        Some(&birth),
    )
    .unwrap()
    .unwrap();
    let after = age_range(
        &CalendarRange {
            earliest: later,
            latest: later,
        },
        Some(&birth),
    )
    .unwrap()
    .unwrap();
    assert_eq!(before.minimum_years, 30);
    assert_eq!(after.minimum_years, 40);
    assert_eq!(after.maximum_years, 40);
    assert_eq!(birth.earliest, time(1970, 1, 1).date);
}
#[test]
fn uncertain_birth_and_origin_keep_age_bounds_and_unknown_birth_stays_unknown() {
    let current = calendar_range(2010, 0).unwrap();
    let birth = BirthDateRange {
        earliest: time(1990, 5, 5).date,
        latest: time(1992, 5, 5).date,
    };
    let age = age_range(&current, Some(&birth)).unwrap().unwrap();
    assert_eq!((age.minimum_years, age.maximum_years), (17, 20));
    assert_eq!(age_range(&current, None).unwrap(), None);
    let bad = BirthDateRange {
        earliest: birth.latest,
        latest: birth.earliest,
    };
    assert_eq!(
        age_range(&current, Some(&bad)),
        Err(CalendarError::InvalidBirthRange)
    );
    let future = BirthDateRange {
        earliest: time(2100, 1, 1).date,
        latest: time(2100, 1, 1).date,
    };
    assert_eq!(
        age_range(&current, Some(&future)),
        Err(CalendarError::BirthInFuture)
    );
}
#[test]
fn leap_day_birth_anniversary_and_possible_unborn_bound_are_explicit() {
    let birth = BirthDateRange {
        earliest: time(2000, 2, 29).date,
        latest: time(2000, 2, 29).date,
    };
    let feb = time(2001, 2, 28);
    let march = time(2001, 3, 1);
    assert_eq!(
        age_range(
            &CalendarRange {
                earliest: feb,
                latest: feb
            },
            Some(&birth)
        )
        .unwrap()
        .unwrap()
        .minimum_years,
        0
    );
    assert_eq!(
        age_range(
            &CalendarRange {
                earliest: march,
                latest: march
            },
            Some(&birth)
        )
        .unwrap()
        .unwrap()
        .minimum_years,
        1
    );
    let birth = BirthDateRange {
        earliest: time(2010, 5, 5).date,
        latest: time(2010, 5, 5).date,
    };
    assert!(
        age_range(&calendar_range(2010, 0).unwrap(), Some(&birth))
            .unwrap()
            .unwrap()
            .may_not_be_born_yet
    );
}
