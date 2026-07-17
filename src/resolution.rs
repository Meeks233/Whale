//! Resolution selection: which heights to download, and which downloaded copy to
//! serve over a share link.
//!
//! Two independent knobs that both answer "how many pixels", kept together
//! because they share the height ladder and the same global/per-site/env
//! precedence:
//!
//! * [`HeightSet`] — the *download* set. Historically a single cap; now a set,
//!   because `item_resolutions` (migration 0011) can hold several copies of one
//!   item and the UI needed a way to ask for them up front instead of
//!   per-item after the fact.
//! * [`StreamQuality`] — the *share* cap. Sharing spends the operator's
//!   upstream on someone else's playback, so it gets a ceiling of its own.

use crate::types::ItemResolution;

/// The heights the UI offers, highest first. `0` is the "highest available"
/// sentinel and is deliberately part of the ladder: it is a distinct user intent
/// from any concrete number ("whatever this source has" vs "exactly 4320"), and
/// it survives sources that improve later.
pub const HEIGHT_LADDER: &[i64] = &[0, 4320, 2160, 1440, 1080, 720, 480, 360];

/// The "highest available" sentinel within a [`HeightSet`].
pub const HIGHEST: i64 = 0;

/// A normalized set of requested download heights.
///
/// Invariants, established once at construction so no consumer has to re-check:
/// deduped, sorted descending, every element is on [`HEIGHT_LADDER`], and
/// [`HIGHEST`] (0) sorts first because "the best there is" is by definition at
/// least as tall as any concrete height beside it.
///
/// The empty set is meaningful and is *not* an error: it means "download
/// nothing, stream only", replacing the old `'none'` string sentinel.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HeightSet(Vec<i64>);

impl HeightSet {
    /// Parse a CSV of heights (the storage form). Unknown, unparseable, and
    /// duplicate entries are dropped rather than rejected: this parses values
    /// coming back out of the DB, where being lenient beats failing a download
    /// over one bad token an old build wrote.
    pub fn parse(csv: &str) -> Self {
        let mut heights: Vec<i64> = csv
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.trim_end_matches('p').parse::<i64>().ok())
            .filter(|h| HEIGHT_LADDER.contains(h))
            .collect();
        Self::normalize(&mut heights);
        Self(heights)
    }

    /// Build from raw heights (the API form), applying the same normalization.
    /// Returns `Err` naming the offender when a height isn't on the ladder —
    /// unlike [`parse`](Self::parse), this is user input arriving now, so a
    /// wrong value is worth a 400 rather than a silent drop.
    pub fn from_heights(heights: &[i64]) -> Result<Self, String> {
        if let Some(bad) = heights.iter().find(|h| !HEIGHT_LADDER.contains(h)) {
            return Err(format!("unsupported resolution height: {bad}"));
        }
        let mut heights = heights.to_vec();
        Self::normalize(&mut heights);
        Ok(Self(heights))
    }

    fn normalize(heights: &mut Vec<i64>) {
        // Descending, but HIGHEST (0) first — it outranks every concrete height.
        heights.sort_unstable_by(|a, b| match (*a, *b) {
            (HIGHEST, HIGHEST) => std::cmp::Ordering::Equal,
            (HIGHEST, _) => std::cmp::Ordering::Less,
            (_, HIGHEST) => std::cmp::Ordering::Greater,
            (x, y) => y.cmp(&x),
        });
        heights.dedup();
    }

    /// The storage form. The empty set round-trips as `""`.
    pub fn to_csv(&self) -> String {
        self.0
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    }

    /// True when nothing should be downloaded (stream-only).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn heights(&self) -> &[i64] {
        &self.0
    }

    /// Resolve the requested set against the heights a source actually offers,
    /// returning the concrete heights to download, highest first.
    ///
    /// This is where "the user picked wrong" becomes "we did something sensible"
    /// — every case collapses to a real, distinct file:
    ///
    /// * [`HIGHEST`] resolves to the tallest the source has.
    /// * A request above the source's ceiling snaps down to that ceiling, so
    ///   asking for 4320p from a 1080p source downloads 1080p once — not a
    ///   second identical copy filed under a different number.
    /// * A request below the source's floor snaps *up* to the floor, matching
    ///   `capped_format`'s `wv*+ba/w` tail: yt-dlp would hand us the smallest
    ///   rendition anyway, so predicting it here keeps the recorded height
    ///   honest.
    /// * Whatever collides after snapping is deduped.
    ///
    /// When `available` is empty (the probe hasn't run, or reported nothing) the
    /// requested heights pass through unsnapped; yt-dlp still applies the cap and
    /// `UNIQUE(item_id, height)` collapses any collision after the fact.
    pub fn resolve(&self, available: &[i64]) -> Vec<i64> {
        if available.is_empty() {
            return self.0.clone();
        }
        let ceiling = available.iter().copied().max();
        let floor = available.iter().copied().min();

        let mut out: Vec<i64> = self
            .0
            .iter()
            .filter_map(|&want| {
                if want == HIGHEST {
                    return ceiling;
                }
                // Tallest rendition at or under the request…
                available
                    .iter()
                    .copied()
                    .filter(|&a| a <= want)
                    .max()
                    // …or, if the request undercuts every rendition, the smallest.
                    .or(floor)
            })
            .collect();
        out.sort_unstable_by(|a, b| b.cmp(a));
        out.dedup();
        out
    }
}

/// The share-bandwidth ceiling for `/api/p/:slug`.
///
/// Named in tiers rather than pixel heights because it is a *policy* ("don't let
/// shares cost me much") applied across sources whose ladders differ; the tier →
/// height mapping is an implementation detail the UI never shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamQuality {
    Lowest,
    Lower,
    Higher,
    Highest,
}

/// Every tier the UI offers, in menu order (cheapest first).
pub const STREAM_QUALITIES: &[StreamQuality] = &[
    StreamQuality::Lowest,
    StreamQuality::Lower,
    StreamQuality::Higher,
    StreamQuality::Highest,
];

impl Default for StreamQuality {
    /// `Higher` (<=1080p): the tier that looks right on a phone and a laptop
    /// without shipping 4K to strangers.
    fn default() -> Self {
        StreamQuality::Higher
    }
}

impl StreamQuality {
    pub fn as_str(&self) -> &'static str {
        match self {
            StreamQuality::Lowest => "lowest",
            StreamQuality::Lower => "lower",
            StreamQuality::Higher => "higher",
            StreamQuality::Highest => "highest",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "lowest" => Some(StreamQuality::Lowest),
            "lower" => Some(StreamQuality::Lower),
            "higher" => Some(StreamQuality::Higher),
            "highest" => Some(StreamQuality::Highest),
            _ => None,
        }
    }

    pub fn valid_list() -> String {
        STREAM_QUALITIES
            .iter()
            .map(|q| q.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The pixel ceiling for this tier; `None` = uncapped.
    pub fn max_height(&self) -> Option<i64> {
        match self {
            StreamQuality::Lowest => Some(360),
            StreamQuality::Lower => Some(480),
            StreamQuality::Higher => Some(1080),
            StreamQuality::Highest => None,
        }
    }

    /// Choose which downloaded variant a share link serves: the tallest at or
    /// under the cap.
    ///
    /// Falls back to the *shortest* available variant when everything exceeds the
    /// cap. Overshooting the ceiling beats a 404 — the alternative is a share
    /// link that silently breaks whenever the operator tightens the tier, which
    /// is a worse failure than one video costing more than intended.
    pub fn pick<'a>(&self, variants: &'a [ItemResolution]) -> Option<&'a ItemResolution> {
        let cap = match self.max_height() {
            None => return variants.iter().max_by_key(|v| v.height),
            Some(c) => c,
        };
        variants
            .iter()
            .filter(|v| v.height <= cap)
            .max_by_key(|v| v.height)
            .or_else(|| variants.iter().min_by_key(|v| v.height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(height: i64) -> ItemResolution {
        ItemResolution {
            height,
            filepath: format!("/d/v [{height}p].mkv"),
            filesize: height * 1000,
        }
    }

    #[test]
    fn parse_normalizes_order_and_duplicates() {
        let s = HeightSet::parse("720,1080,720,480");
        assert_eq!(s.heights(), &[1080, 720, 480]);
        assert_eq!(s.to_csv(), "1080,720,480");
    }

    #[test]
    fn highest_sentinel_sorts_ahead_of_concrete_heights() {
        assert_eq!(HeightSet::parse("480,0,1080").heights(), &[0, 1080, 480]);
    }

    #[test]
    fn empty_csv_is_the_empty_set_not_an_error() {
        let s = HeightSet::parse("");
        assert!(s.is_empty());
        assert_eq!(s.to_csv(), "");
    }

    #[test]
    fn parse_drops_junk_and_off_ladder_values() {
        // Lenient on the way out of the DB: 999 isn't on the ladder, "abc" isn't
        // a number, and a stray "p" suffix is tolerated.
        assert_eq!(
            HeightSet::parse("1080p,abc,999,,720").heights(),
            &[1080, 720]
        );
    }

    #[test]
    fn from_heights_rejects_off_ladder_input() {
        assert!(HeightSet::from_heights(&[1080, 999]).is_err());
        assert_eq!(
            HeightSet::from_heights(&[720, 1080, 720])
                .unwrap()
                .heights(),
            &[1080, 720]
        );
    }

    #[test]
    fn csv_round_trips() {
        for csv in ["", "0", "1080", "0,2160,720", "4320,1080,360"] {
            assert_eq!(HeightSet::parse(csv).to_csv(), csv, "round-trip {csv:?}");
        }
    }

    // --- resolve(): the 错选 / 漏选 / 重选 cases -------------------------------

    #[test]
    fn resolve_maps_highest_to_the_sources_ceiling() {
        assert_eq!(HeightSet::parse("0").resolve(&[1080, 720, 480]), vec![1080]);
    }

    #[test]
    fn resolve_snaps_over_tall_requests_down_and_dedupes() {
        // 4320 and 2160 both collapse onto a 1080p source — one download, not
        // three identical files under three different names.
        assert_eq!(
            HeightSet::parse("4320,2160,1080").resolve(&[1080, 720]),
            vec![1080]
        );
    }

    #[test]
    fn resolve_snaps_under_short_requests_up_to_the_floor() {
        // Mirrors capped_format's `wv*+ba/w` tail: 360 can't be had, so the
        // smallest rendition is what actually lands.
        assert_eq!(HeightSet::parse("360").resolve(&[1080, 720]), vec![720]);
    }

    #[test]
    fn resolve_dedupes_highest_against_an_equal_concrete_request() {
        // "highest" + "1080" on a 1080p source is one file, asked for twice.
        assert_eq!(HeightSet::parse("0,1080").resolve(&[1080, 480]), vec![1080]);
    }

    #[test]
    fn resolve_picks_the_tallest_at_or_under_each_request() {
        // 1080 has no exact match; 720 is the tallest that fits.
        assert_eq!(
            HeightSet::parse("1080,480").resolve(&[720, 480, 360]),
            vec![720, 480]
        );
    }

    #[test]
    fn resolve_keeps_genuinely_distinct_requests() {
        assert_eq!(
            HeightSet::parse("0,720,360").resolve(&[2160, 1080, 720, 480, 360]),
            vec![2160, 720, 360]
        );
    }

    #[test]
    fn resolve_of_the_empty_set_downloads_nothing() {
        assert!(HeightSet::parse("").resolve(&[1080]).is_empty());
    }

    #[test]
    fn resolve_without_a_probe_passes_requests_through() {
        // No available list → don't guess; yt-dlp caps and UNIQUE dedupes later.
        assert_eq!(HeightSet::parse("1080,480").resolve(&[]), vec![1080, 480]);
    }

    #[test]
    fn resolve_never_exceeds_the_request_count() {
        // The headline promise of the multi-select: N picked → at most N files.
        for csv in ["0", "1080,480", "0,4320,2160,1440,1080,720,480,360"] {
            let set = HeightSet::parse(csv);
            let got = set.resolve(&[2160, 1080, 720]);
            assert!(got.len() <= set.heights().len(), "{csv:?} produced {got:?}");
        }
    }

    #[test]
    fn resolve_output_is_always_available_and_unique() {
        let available = [2160, 1080, 720, 480, 360];
        let got = HeightSet::parse("0,4320,2160,1440,1080,720,480,360").resolve(&available);
        let mut sorted = got.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), got.len(), "duplicates in {got:?}");
        assert!(
            got.iter().all(|h| available.contains(h)),
            "phantom in {got:?}"
        );
    }

    // --- StreamQuality -------------------------------------------------------

    #[test]
    fn stream_quality_defaults_to_higher() {
        assert_eq!(StreamQuality::default(), StreamQuality::Higher);
        assert_eq!(StreamQuality::default().max_height(), Some(1080));
    }

    #[test]
    fn stream_quality_round_trips() {
        for q in STREAM_QUALITIES {
            assert_eq!(StreamQuality::parse(q.as_str()), Some(*q));
        }
        assert_eq!(StreamQuality::parse("HIGHER"), Some(StreamQuality::Higher));
        assert_eq!(StreamQuality::parse("potato"), None);
    }

    #[test]
    fn stream_quality_picks_tallest_under_the_cap() {
        let v = [res(2160), res(1080), res(480)];
        assert_eq!(StreamQuality::Higher.pick(&v).unwrap().height, 1080);
        assert_eq!(StreamQuality::Lower.pick(&v).unwrap().height, 480);
        assert_eq!(StreamQuality::Highest.pick(&v).unwrap().height, 2160);
    }

    #[test]
    fn stream_quality_falls_back_to_the_smallest_when_all_exceed_the_cap() {
        // Tightening the tier must not 404 an already-shared link.
        let v = [res(2160), res(1080)];
        assert_eq!(StreamQuality::Lowest.pick(&v).unwrap().height, 1080);
    }

    #[test]
    fn stream_quality_pick_of_nothing_is_none() {
        assert!(StreamQuality::Higher.pick(&[]).is_none());
        assert!(StreamQuality::Highest.pick(&[]).is_none());
    }

    #[test]
    fn stream_quality_pick_is_exact_when_a_variant_matches_the_cap() {
        let v = [res(1080), res(720), res(360)];
        assert_eq!(StreamQuality::Lowest.pick(&v).unwrap().height, 360);
    }
}
