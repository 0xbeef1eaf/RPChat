//! Pure placement planning: turns the merged settings of an overlay plus the current
//! monitor list into an [`OverlayPlan`] (layer, anchored edges, margins, size, monitor).
//! No GTK here so it is unit-tested with fixtures and exercised by `--self-test`.
//!
//! The semantics mirror `apps/desktop/src/main/display/placement.ts` so both backends
//! place overlays identically.

use serde::Serialize;

use crate::protocol::{
    Anchor, Layer, MonitorInfo, MonitorSelector, ShowParams, UpdatePatch, DEFAULT_HEIGHT,
    DEFAULT_NAMESPACE,
};

/// Smallest overlay size we will ever request (logical px).
pub const MIN_SIZE: i32 = 16;

/// The merged, current settings of one overlay: the `show` request plus every
/// `update` patch applied since, plus the last `content-size` the page reported.
#[derive(Debug, Clone, PartialEq)]
pub struct OverlaySettings {
    pub layer: Layer,
    pub anchor: Anchor,
    pub margin_px: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub monitor: Option<MonitorSelector>,
    pub width: f64,
    /// Explicit height from the app; when `None` the page's `content-size` drives it.
    pub height: Option<f64>,
    pub opacity: f64,
    pub click_through: bool,
    pub namespace: String,
    /// Last `{ type: "content-size", width, height }` reported by the page.
    pub content_size: Option<(f64, f64)>,
}

impl OverlaySettings {
    pub fn from_show(show: &ShowParams) -> OverlaySettings {
        OverlaySettings {
            layer: show.layer,
            anchor: show.anchor,
            margin_px: show.margin_px,
            x: show.x,
            y: show.y,
            monitor: show.monitor.clone(),
            width: show.width,
            height: show.height,
            opacity: show.opacity,
            click_through: show.click_through,
            namespace: show
                .namespace
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned()),
            content_size: None,
        }
    }

    /// Merge an `update` patch. Absent fields keep their value. Setting `anchor`
    /// without `x`/`y` switches back to the preset (clears any explicit offset);
    /// setting `x`/`y` switches to explicit positioning.
    pub fn apply(&mut self, patch: &UpdatePatch) {
        if let Some(layer) = patch.layer {
            self.layer = layer;
        }
        if let Some(anchor) = patch.anchor {
            self.anchor = anchor;
            if patch.x.is_none() && patch.y.is_none() {
                self.x = None;
                self.y = None;
            }
        }
        if let Some(m) = patch.margin_px {
            self.margin_px = m;
        }
        if patch.x.is_some() {
            self.x = patch.x;
        }
        if patch.y.is_some() {
            self.y = patch.y;
        }
        if let Some(m) = &patch.monitor {
            self.monitor = Some(m.clone());
        }
        if let Some(w) = patch.width {
            self.width = w;
        }
        if patch.height.is_some() {
            self.height = patch.height;
        }
        if let Some(o) = patch.opacity {
            self.opacity = o;
        }
        if let Some(c) = patch.click_through {
            self.click_through = c;
        }
    }

    /// Record a `content-size` report. Returns true when it changes the planned size
    /// (i.e. no explicit height was given and the value differs from the last one).
    pub fn set_content_size(&mut self, width: f64, height: f64) -> bool {
        let next = Some((width, height));
        if self.content_size == next {
            return false;
        }
        self.content_size = next;
        self.height.is_none()
    }
}

/// Per-edge values (layer-shell has four independent edges).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Edges<T> {
    pub top: T,
    pub bottom: T,
    pub left: T,
    pub right: T,
}

/// Everything `overlay.rs` needs to configure a window; fully resolved numbers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPlan {
    pub layer: Layer,
    /// Which edges the surface is anchored to. `center` anchors nothing.
    pub anchors: Edges<bool>,
    /// Margins in logical px; only meaningful on anchored edges.
    pub margins: Edges<i32>,
    pub width: i32,
    pub height: i32,
    /// Index into the monitor list passed to [`plan`], or `None` for the compositor default.
    pub monitor_index: Option<usize>,
    pub opacity: f64,
    pub click_through: bool,
    pub namespace: String,
}

/// Resolve a monitor selector against the current monitor list:
/// `index` → `name` (exact, then case-insensitive, then id) → the monitor containing `(x, y)`.
/// Returns `None` when nothing matches (the compositor's default monitor is used).
pub fn select_monitor(selector: Option<&MonitorSelector>, monitors: &[MonitorInfo]) -> Option<usize> {
    let (index, name, point) = match selector? {
        MonitorSelector::Spec { index, name, x, y } => {
            (*index, name.as_deref(), x.and_then(|x| y.map(|y| (x, y))))
        }
        MonitorSelector::Index(i) => (Some(*i), None, None),
        MonitorSelector::Name(n) => (None, Some(n.as_str()), None),
    };
    if let Some(i) = index {
        if i >= 0 && (i as usize) < monitors.len() {
            return Some(i as usize);
        }
    }
    if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
        if let Some(i) = monitors.iter().position(|m| m.name == name) {
            return Some(i);
        }
        let lower = name.to_lowercase();
        if let Some(i) = monitors.iter().position(|m| m.name.to_lowercase() == lower) {
            return Some(i);
        }
        if let Some(i) = monitors.iter().position(|m| m.id == name) {
            return Some(i);
        }
    }
    if let Some((x, y)) = point {
        if let Some(i) = monitors.iter().position(|m| m.contains(x, y)) {
            return Some(i);
        }
    }
    None
}

/// The monitor used to resolve fractions and clamp sizes: the selected one, else the
/// primary, else the first.
fn reference_monitor(selected: Option<usize>, monitors: &[MonitorInfo]) -> Option<&MonitorInfo> {
    selected
        .and_then(|i| monitors.get(i))
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}

fn clamp_i32(v: i32, lo: i32, hi: i32) -> i32 {
    v.max(lo).min(hi.max(lo))
}

fn finite_positive(v: f64) -> Option<f64> {
    (v.is_finite() && v > 0.0).then_some(v)
}

/// `0..=1` → fraction of the extent, otherwise logical px (as in `placement.ts`).
fn explicit_offset(value: f64, extent: i32) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    if (0.0..=1.0).contains(&value) {
        (value * extent as f64).round() as i32
    } else {
        value.round() as i32
    }
}

/// Compute the plan for `settings` against `monitors`.
pub fn plan(settings: &OverlaySettings, monitors: &[MonitorInfo]) -> OverlayPlan {
    let monitor_index = select_monitor(settings.monitor.as_ref(), monitors);
    let reference = reference_monitor(monitor_index, monitors);
    // Without any monitor information fall back to a generous virtual screen so
    // fractions and clamps still produce sane numbers.
    let (mon_w, mon_h) = reference.map(|m| (m.width.max(1), m.height.max(1))).unwrap_or((1920, 1080));

    let margin = if settings.margin_px.is_finite() { settings.margin_px.max(0.0).round() as i32 } else { 0 };

    // Size: explicit width always wins; the height is explicit, else the page's
    // reported content height, else the default.
    let wanted_w = finite_positive(settings.width).unwrap_or(crate::protocol::DEFAULT_WIDTH);
    let wanted_h = settings
        .height
        .and_then(finite_positive)
        .or_else(|| settings.content_size.and_then(|(_, h)| finite_positive(h)))
        .unwrap_or(DEFAULT_HEIGHT);
    let width = clamp_i32(wanted_w.round() as i32, MIN_SIZE.min(mon_w), mon_w);
    let height = clamp_i32(wanted_h.round() as i32, MIN_SIZE.min(mon_h), mon_h);

    let explicit = settings.x.is_some() || settings.y.is_some();
    let (anchors, margins, width, height) = if explicit {
        // Explicit position: anchor top-left and express the position as margins.
        let left = match settings.x {
            Some(x) => explicit_offset(x, mon_w),
            None => preset_left(settings.anchor, mon_w, width, margin),
        };
        let top = match settings.y {
            Some(y) => explicit_offset(y, mon_h),
            None => preset_top(settings.anchor, mon_h, height, margin),
        };
        let left = clamp_i32(left, 0, mon_w - width);
        let top = clamp_i32(top, 0, mon_h - height);
        (
            Edges { top: true, bottom: false, left: true, right: false },
            Edges { top, bottom: 0, left, right: 0 },
            width,
            height,
        )
    } else {
        let (anchors, margins) = preset_edges(settings.anchor, margin);
        // Keep the surface inside the work area even with large margins.
        let avail_w = mon_w - margins.left - margins.right;
        let avail_h = mon_h - margins.top - margins.bottom;
        (
            anchors,
            margins,
            clamp_i32(width, MIN_SIZE.min(avail_w.max(1)), avail_w.max(1)),
            clamp_i32(height, MIN_SIZE.min(avail_h.max(1)), avail_h.max(1)),
        )
    };

    let opacity = if settings.opacity.is_finite() { settings.opacity.clamp(0.0, 1.0) } else { 1.0 };

    OverlayPlan {
        layer: settings.layer,
        anchors,
        margins,
        width,
        height,
        monitor_index,
        opacity,
        click_through: settings.click_through,
        namespace: settings.namespace.clone(),
    }
}

fn preset_edges(anchor: Anchor, margin: i32) -> (Edges<bool>, Edges<i32>) {
    let mut a = Edges::<bool>::default();
    let mut m = Edges::<i32>::default();
    match anchor {
        Anchor::Center => {}
        Anchor::TopLeft => {
            a.top = true;
            a.left = true;
            m.top = margin;
            m.left = margin;
        }
        Anchor::TopRight => {
            a.top = true;
            a.right = true;
            m.top = margin;
            m.right = margin;
        }
        Anchor::BottomLeft => {
            a.bottom = true;
            a.left = true;
            m.bottom = margin;
            m.left = margin;
        }
        Anchor::BottomRight => {
            a.bottom = true;
            a.right = true;
            m.bottom = margin;
            m.right = margin;
        }
    }
    (a, m)
}

fn preset_left(anchor: Anchor, mon_w: i32, width: i32, margin: i32) -> i32 {
    match anchor {
        Anchor::TopLeft | Anchor::BottomLeft => margin,
        Anchor::TopRight | Anchor::BottomRight => mon_w - width - margin,
        Anchor::Center => ((mon_w - width) as f64 / 2.0).round() as i32,
    }
}

fn preset_top(anchor: Anchor, mon_h: i32, height: i32, margin: i32) -> i32 {
    match anchor {
        Anchor::TopLeft | Anchor::TopRight => margin,
        Anchor::BottomLeft | Anchor::BottomRight => mon_h - height - margin,
        Anchor::Center => ((mon_h - height) as f64 / 2.0).round() as i32,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitors::fixture_monitors;

    fn show(json: &str) -> OverlaySettings {
        let s: ShowParams = serde_json::from_str(json).expect("show json");
        OverlaySettings::from_show(&s)
    }

    fn patch(json: &str) -> UpdatePatch {
        serde_json::from_str(json).expect("patch json")
    }

    #[test]
    fn center_anchors_nothing() {
        let p = plan(&show(r#"{"id":"a","url":"u"}"#), &fixture_monitors());
        assert_eq!(p.anchors, Edges::default());
        assert_eq!(p.margins, Edges::default());
        assert_eq!((p.width, p.height), (480, 320));
        assert_eq!(p.monitor_index, None);
        assert_eq!(p.layer, Layer::Top);
        assert_eq!(p.opacity, 1.0);
        assert!(!p.click_through);
        assert_eq!(p.namespace, DEFAULT_NAMESPACE);
    }

    #[test]
    fn presets_anchor_two_edges_with_margin() {
        let m = fixture_monitors();
        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"bottom-right","marginPx":30}"#), &m);
        assert_eq!(p.anchors, Edges { top: false, bottom: true, left: false, right: true });
        assert_eq!(p.margins, Edges { top: 0, bottom: 30, left: 0, right: 30 });

        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"top-left"}"#), &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: true, right: false });
        assert_eq!(p.margins, Edges { top: 24, bottom: 0, left: 24, right: 0 });

        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"top-right","marginPx":0}"#), &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: false, right: true });
        assert_eq!(p.margins, Edges::default());

        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"bottom-left","marginPx":-5}"#), &m);
        assert_eq!(p.anchors, Edges { top: false, bottom: true, left: true, right: false });
        assert_eq!(p.margins, Edges::default(), "negative margins are clamped to 0");
    }

    #[test]
    fn explicit_xy_forces_top_left_and_resolves_fractions() {
        let m = fixture_monitors(); // primary: 2560x1400 work area
        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"bottom-right","x":0.5,"y":0.25,"width":400,"height":200}"#), &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: true, right: false });
        assert_eq!(p.margins, Edges { top: 350, bottom: 0, left: 1280, right: 0 });
        assert_eq!((p.width, p.height), (400, 200));

        // Pixels (> 1) are used as-is; 1.0 is still a fraction; 0 is 0.
        let p = plan(&show(r#"{"id":"a","url":"u","x":100,"y":0,"width":400,"height":200}"#), &m);
        assert_eq!(p.margins, Edges { top: 0, bottom: 0, left: 100, right: 0 });
        let p = plan(&show(r#"{"id":"a","url":"u","x":1,"y":1,"width":400,"height":200}"#), &m);
        assert_eq!(p.margins, Edges { top: 1200, bottom: 0, left: 2160, right: 0 }, "1.0 = far edge, clamped inside");
    }

    #[test]
    fn explicit_position_is_clamped_inside_monitor() {
        let m = fixture_monitors();
        let p = plan(&show(r#"{"id":"a","url":"u","x":5000,"y":-40,"width":400,"height":200}"#), &m);
        assert_eq!(p.margins, Edges { top: 0, bottom: 0, left: 2160, right: 0 });
    }

    #[test]
    fn only_x_given_uses_preset_for_y() {
        let m = fixture_monitors();
        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"bottom-left","x":10,"width":400,"height":200}"#), &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: true, right: false });
        assert_eq!(p.margins, Edges { top: 1400 - 200 - 24, bottom: 0, left: 10, right: 0 });
        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"center","y":10,"width":400,"height":200}"#), &m);
        assert_eq!(p.margins, Edges { top: 10, bottom: 0, left: 1080, right: 0 });
    }

    #[test]
    fn fractions_resolve_against_selected_monitor() {
        let m = fixture_monitors(); // second monitor: 1920x1080 at 2560,0
        let p = plan(&show(r#"{"id":"a","url":"u","monitor":{"index":1},"x":0.5,"y":0.5,"width":100,"height":100}"#), &m);
        assert_eq!(p.monitor_index, Some(1));
        assert_eq!(p.margins, Edges { top: 540, bottom: 0, left: 960, right: 0 });
    }

    #[test]
    fn monitor_selection_order() {
        let m = fixture_monitors();
        let sel = |json: &str| select_monitor(Some(&serde_json::from_str(json).unwrap()), &m);
        assert_eq!(sel(r#"{"index":1}"#), Some(1));
        assert_eq!(sel(r#"{"index":7,"name":"HDMI-A-1"}"#), Some(1), "bad index falls through to name");
        assert_eq!(sel(r#"{"name":"dp-1"}"#), Some(0), "case-insensitive name");
        assert_eq!(sel(r#"{"name":"1"}"#), Some(1), "id matches too");
        assert_eq!(sel(r#"{"name":"nope","x":3000,"y":100}"#), Some(1), "unknown name falls through to point");
        assert_eq!(sel(r#"{"x":100,"y":100}"#), Some(0));
        assert_eq!(sel(r#"{"x":9999,"y":9999}"#), None, "point outside everything → default");
        assert_eq!(sel(r#"{"index":-1}"#), None);
        assert_eq!(sel(r#"{}"#), None);
        assert_eq!(sel("1"), Some(1));
        assert_eq!(sel(r#""HDMI-A-1""#), Some(1));
        assert_eq!(select_monitor(None, &m), None);
        assert_eq!(select_monitor(Some(&MonitorSelector::Index(0)), &[]), None);
    }

    #[test]
    fn size_is_clamped_to_monitor_and_minimum() {
        let m = fixture_monitors();
        let p = plan(&show(r#"{"id":"a","url":"u","width":99999,"height":99999}"#), &m);
        assert_eq!((p.width, p.height), (2560, 1400));
        let p = plan(&show(r#"{"id":"a","url":"u","width":1,"height":-3}"#), &m);
        assert_eq!((p.width, p.height), (16, 320), "tiny width → MIN_SIZE, non-positive height → default");
        // With a preset anchor the margins shrink the available space.
        let p = plan(&show(r#"{"id":"a","url":"u","anchor":"top-left","marginPx":100,"width":2560,"height":1400}"#), &m);
        assert_eq!((p.width, p.height), (2460, 1300));
        // No monitors at all: still sane.
        let p = plan(&show(r#"{"id":"a","url":"u","x":0.5,"width":400,"height":200}"#), &[]);
        assert_eq!(p.margins.left, 960, "0.5 of the 1920px fallback screen");
        assert_eq!(p.monitor_index, None);
    }

    #[test]
    fn content_size_drives_height_only_without_explicit_height() {
        let m = fixture_monitors();
        let mut s = show(r#"{"id":"a","url":"u","anchor":"bottom-right","width":480}"#);
        assert_eq!(plan(&s, &m).height, 320);
        assert!(s.set_content_size(300.0, 180.0));
        let p = plan(&s, &m);
        assert_eq!((p.width, p.height), (480, 180), "width stays fixed, height follows content");
        assert!(!s.set_content_size(300.0, 180.0), "same size again → no change");
        assert!(s.set_content_size(300.0, 5000.0));
        assert_eq!(plan(&s, &m).height, 1400 - 24, "content height clamped to the work area minus margin");

        let mut s = show(r#"{"id":"a","url":"u","height":200}"#);
        assert!(!s.set_content_size(300.0, 600.0), "explicit height ignores content-size");
        assert_eq!(plan(&s, &m).height, 200);
        s.apply(&patch(r#"{"height":null}"#));
        assert_eq!(plan(&s, &m).height, 200, "null in a patch is 'unchanged'");
    }

    #[test]
    fn update_patch_merges() {
        let m = fixture_monitors();
        let mut s = show(r#"{"id":"a","url":"u","anchor":"top-left","opacity":0.5,"namespace":"custom"}"#);
        s.apply(&patch(r#"{"layer":"background","opacity":0.9,"clickThrough":true,"marginPx":8,"width":300,"monitor":{"index":1}}"#));
        let p = plan(&s, &m);
        assert_eq!(p.layer, Layer::Background);
        assert_eq!(p.opacity, 0.9);
        assert!(p.click_through);
        assert_eq!(p.margins, Edges { top: 8, bottom: 0, left: 8, right: 0 });
        assert_eq!(p.width, 300);
        assert_eq!(p.monitor_index, Some(1));
        assert_eq!(p.namespace, "custom", "namespace is not patchable");

        // x/y in a patch switch to explicit positioning...
        s.apply(&patch(r#"{"x":10,"y":20}"#));
        let p = plan(&s, &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: true, right: false });
        assert_eq!(p.margins, Edges { top: 20, bottom: 0, left: 10, right: 0 });
        // ...and an anchor without x/y switches back to the preset.
        s.apply(&patch(r#"{"anchor":"bottom-right"}"#));
        let p = plan(&s, &m);
        assert_eq!(p.anchors, Edges { top: false, bottom: true, left: false, right: true });
        assert_eq!(p.margins, Edges { top: 0, bottom: 8, left: 0, right: 8 });
        // anchor + x in the same patch keeps explicit mode (x set, y from the preset).
        s.apply(&patch(r#"{"anchor":"top-right","x":0.5}"#));
        let p = plan(&s, &m);
        assert_eq!(p.anchors, Edges { top: true, bottom: false, left: true, right: false });
        assert_eq!(p.margins, Edges { top: 8, bottom: 0, left: 960, right: 0 });
    }

    #[test]
    fn opacity_is_clamped() {
        let m = fixture_monitors();
        assert_eq!(plan(&show(r#"{"id":"a","url":"u","opacity":3}"#), &m).opacity, 1.0);
        assert_eq!(plan(&show(r#"{"id":"a","url":"u","opacity":-1}"#), &m).opacity, 0.0);
    }

    #[test]
    fn blank_namespace_falls_back_to_default() {
        let s = show(r#"{"id":"a","url":"u","namespace":"  "}"#);
        assert_eq!(s.namespace, DEFAULT_NAMESPACE);
    }

    #[test]
    fn plan_serialises_camel_case() {
        let p = plan(&show(r#"{"id":"a","url":"u","clickThrough":true}"#), &fixture_monitors());
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["clickThrough"], true);
        assert_eq!(v["monitorIndex"], serde_json::Value::Null);
        assert_eq!(v["anchors"]["top"], false);
    }
}
