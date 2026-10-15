//! Pure proleptic Gregorian projections. The stored year is an origin, not an
//! exact birthday or January 1 assertion. Unknown starting month/day produces
//! a range; astronomical year zero exists only inside the arithmetic.
use serde::{Deserialize, Serialize};

const MAX_YEAR: i32 = 999_999;
const DAY_SECONDS: i64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarError {
    InvalidDate,
    OutOfRange,
    InvalidBirthRange,
    BirthInFuture,
}
impl std::fmt::Display for CalendarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidDate => "calendar_invalid_date",
            Self::OutOfRange => "calendar_out_of_range",
            Self::InvalidBirthRange => "calendar_invalid_birth_range",
            Self::BirthInFuture => "calendar_birth_in_future",
        })
    }
}
impl std::error::Error for CalendarError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarDate {
    pub era_year: i32,
    pub month: u8,
    pub day: u8,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarDateTime {
    pub date: CalendarDate,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarRange {
    pub earliest: CalendarDateTime,
    pub latest: CalendarDateTime,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BirthDateRange {
    pub earliest: CalendarDate,
    pub latest: CalendarDate,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgeRange {
    pub minimum_years: u32,
    pub maximum_years: u32,
    pub may_not_be_born_yet: bool,
}

fn astronomical(year: i32) -> Result<i64, CalendarError> {
    if year == 0 || !(-MAX_YEAR..=MAX_YEAR).contains(&year) {
        return Err(CalendarError::InvalidDate);
    }
    Ok(i64::from(year) + i64::from(year < 0))
}
fn historical(year: i64) -> Result<i32, CalendarError> {
    let year = year - i64::from(year <= 0);
    let year = i32::try_from(year).map_err(|_| CalendarError::OutOfRange)?;
    if !(-MAX_YEAR..=MAX_YEAR).contains(&year) {
        return Err(CalendarError::OutOfRange);
    }
    Ok(year)
}
fn leap(year: i64) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}
fn days(date: CalendarDate) -> Result<i64, CalendarError> {
    let mut y = astronomical(date.era_year)?;
    let length = match date.month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap(y) {
                29
            } else {
                28
            }
        }
        _ => return Err(CalendarError::InvalidDate),
    };
    if date.day == 0 || date.day > length {
        return Err(CalendarError::InvalidDate);
    }
    let m = i64::from(date.month);
    y -= i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(date.day) - 1;
    Ok(era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy)
}
fn from_days(z: i64) -> Result<CalendarDate, CalendarError> {
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    Ok(CalendarDate {
        era_year: historical(y)?,
        month: m as u8,
        day: d as u8,
    })
}
fn seconds(time: CalendarDateTime) -> Result<i64, CalendarError> {
    if time.hour > 23 || time.minute > 59 || time.second > 59 {
        return Err(CalendarError::InvalidDate);
    }
    Ok(days(time.date)? * DAY_SECONDS
        + i64::from(time.hour) * 3600
        + i64::from(time.minute) * 60
        + i64::from(time.second))
}
fn from_seconds(value: i64) -> Result<CalendarDateTime, CalendarError> {
    let remainder = value.rem_euclid(DAY_SECONDS);
    Ok(CalendarDateTime {
        date: from_days(value.div_euclid(DAY_SECONDS))?,
        hour: (remainder / 3600) as u8,
        minute: ((remainder % 3600) / 60) as u8,
        second: (remainder % 60) as u8,
    })
}
pub fn advance_calendar_time(
    origin: CalendarDateTime,
    elapsed_seconds: u64,
) -> Result<CalendarDateTime, CalendarError> {
    let elapsed = i64::try_from(elapsed_seconds).map_err(|_| CalendarError::OutOfRange)?;
    from_seconds(
        seconds(origin)?
            .checked_add(elapsed)
            .ok_or(CalendarError::OutOfRange)?,
    )
}
/// No exact start date is invented for a year-precision historical opening.
pub fn calendar_range(era_year: i32, elapsed_seconds: u64) -> Result<CalendarRange, CalendarError> {
    astronomical(era_year)?;
    let earliest = advance_calendar_time(
        CalendarDateTime {
            date: CalendarDate {
                era_year,
                month: 1,
                day: 1,
            },
            hour: 0,
            minute: 0,
            second: 0,
        },
        elapsed_seconds,
    )?;
    let latest = advance_calendar_time(
        CalendarDateTime {
            date: CalendarDate {
                era_year,
                month: 12,
                day: 31,
            },
            hour: 23,
            minute: 59,
            second: 59,
        },
        elapsed_seconds,
    )?;
    Ok(CalendarRange { earliest, latest })
}
fn years_between(birth: CalendarDate, current: CalendarDate) -> Result<i64, CalendarError> {
    // February 29's anniversary occurs on March 1 in a non-leap year.
    Ok(astronomical(current.era_year)?
        - astronomical(birth.era_year)?
        - i64::from((current.month, current.day) < (birth.month, birth.day)))
}
pub fn age_range(
    current: &CalendarRange,
    birth: Option<&BirthDateRange>,
) -> Result<Option<AgeRange>, CalendarError> {
    let Some(birth) = birth else { return Ok(None) };
    let first = seconds(current.earliest)?;
    let last = seconds(current.latest)?;
    let birth_first = days(birth.earliest)?;
    let birth_last = days(birth.latest)?;
    if first > last || birth_first > birth_last {
        return Err(CalendarError::InvalidBirthRange);
    }
    if last.div_euclid(DAY_SECONDS) < birth_first {
        return Err(CalendarError::BirthInFuture);
    }
    let minimum = years_between(birth.latest, current.earliest.date)?.max(0);
    let maximum = years_between(birth.earliest, current.latest.date)?.max(0);
    Ok(Some(AgeRange {
        minimum_years: minimum as u32,
        maximum_years: maximum as u32,
        may_not_be_born_yet: first.div_euclid(DAY_SECONDS) < birth_last,
    }))
}
