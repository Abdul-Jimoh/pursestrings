use near_sdk::near;

pub const BUCKETS: u64 = 24;

/// A rolling sum over `period_s`, kept as `BUCKETS` time buckets of `period_s / BUCKETS`
/// seconds each. The window it covers is accurate to one bucket.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ring {
    slots: Vec<(u64, u128)>,
}

pub const fn bucket_at(period_s: u32, now_s: u64) -> u64 {
    now_s / (period_s as u64 / BUCKETS)
}

impl Ring {
    pub fn used(&self, period_s: u32, now_s: u64) -> u128 {
        let cur = bucket_at(period_s, now_s);
        self.slots
            .iter()
            .filter(|(b, _)| *b <= cur && cur - *b < BUCKETS)
            .fold(0u128, |acc, (_, a)| acc.saturating_add(*a))
    }

    /// Returns the bucket the amount landed in, so it can be released later.
    pub fn add(&mut self, period_s: u32, now_s: u64, amount: u128) -> u64 {
        if self.slots.is_empty() {
            self.slots = vec![(u64::MAX, 0); BUCKETS as usize];
        }
        let cur = bucket_at(period_s, now_s);
        let slot = &mut self.slots[(cur % BUCKETS) as usize];
        if slot.0 != cur {
            *slot = (cur, 0);
        }
        slot.1 = slot.1.checked_add(amount).expect("window overflow");
        cur
    }

    /// A bucket that has already rotated out has nothing left to release.
    pub fn remove(&mut self, bucket: u64, amount: u128) {
        if let Some(slot) = self.slots.get_mut((bucket % BUCKETS) as usize)
            && slot.0 == bucket
        {
            slot.1 = slot.1.saturating_sub(amount);
        }
    }

    /// Seconds until enough old buckets rotate out for `used` to drop by at least `need`.
    pub fn seconds_until_freed(&self, period_s: u32, now_s: u64, need: u128) -> u32 {
        let len = period_s as u64 / BUCKETS;
        let cur = bucket_at(period_s, now_s);
        let mut live: Vec<(u64, u128)> = self
            .slots
            .iter()
            .copied()
            .filter(|(b, a)| *b <= cur && cur - *b < BUCKETS && *a > 0)
            .collect();
        live.sort_unstable();
        let mut freed = 0u128;
        for (b, a) in live {
            freed = freed.saturating_add(a);
            if freed >= need {
                let at = (b + BUCKETS) * len;
                return u32::try_from(at.saturating_sub(now_s)).unwrap_or(u32::MAX);
            }
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u32 = 86_400;
    const HOUR: u64 = 3_600;

    #[test]
    fn sums_within_period_and_forgets_after() {
        let mut r = Ring::default();
        let t0 = 1_000 * u64::from(DAY);
        r.add(DAY, t0, 10);
        r.add(DAY, t0 + 5 * HOUR, 20);
        assert_eq!(r.used(DAY, t0 + 5 * HOUR), 30);
        assert_eq!(r.used(DAY, t0 + 23 * HOUR), 30);
        assert_eq!(r.used(DAY, t0 + 24 * HOUR), 20);
        assert_eq!(r.used(DAY, t0 + 29 * HOUR), 0);
    }

    #[test]
    fn reused_slot_is_reset() {
        let mut r = Ring::default();
        let t0 = 1_000 * u64::from(DAY);
        r.add(DAY, t0, 10);
        r.add(DAY, t0 + 24 * HOUR, 7);
        assert_eq!(r.used(DAY, t0 + 24 * HOUR), 7);
    }

    #[test]
    fn remove_only_hits_its_own_bucket() {
        let mut r = Ring::default();
        let t0 = 1_000 * u64::from(DAY);
        let b = r.add(DAY, t0, 10);
        r.remove(b, 4);
        assert_eq!(r.used(DAY, t0), 6);
        r.add(DAY, t0 + 24 * HOUR, 5);
        r.remove(b, 6);
        assert_eq!(r.used(DAY, t0 + 24 * HOUR), 5);
    }

    #[test]
    fn untouched_ring_is_empty() {
        assert_eq!(Ring::default().used(DAY, 0), 0);
        let mut r = Ring::default();
        r.add(DAY, 5 * HOUR, 1);
        assert_eq!(r.used(DAY, 0), 0);
    }

    #[test]
    fn seconds_until_freed_points_at_oldest_bucket_expiry() {
        let mut r = Ring::default();
        let t0 = 1_000 * u64::from(DAY);
        r.add(DAY, t0, 10);
        r.add(DAY, t0 + 2 * HOUR, 10);
        let now = t0 + 3 * HOUR;
        assert_eq!(r.seconds_until_freed(DAY, now, 5), (21 * HOUR) as u32);
        assert_eq!(r.seconds_until_freed(DAY, now, 15), (23 * HOUR) as u32);
    }
}
