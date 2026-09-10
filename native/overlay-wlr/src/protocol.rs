//! Wire types for the JSON-lines protocol between the desktop app and this helper.
//!
//! See `docs/spec/overlay-helper.md` ("Process protocol"). Requests arrive on stdin,
//! one JSON object per line; events go out on stdout the same way. Every request may
//! carry a `seq` number which the corresponding reply echoes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version this binary speaks (the `hello.version` it accepts and echoes).
pub const PROTOCOL_VERSION: u32 = 1;

/// Default width of an overlay page in logical px (matches `DEFAULT_OVERLAY_WIDTH` in the app).
pub const DEFAULT_WIDTH: f64 = 480.0;
/// Height used until the page reports `content-size` (matches `DEFAULT_OVERLAY_HEIGHT`).
pub const DEFAULT_HEIGHT: f64 = 320.0;
/// Gap kept from the monitor edges for anchor presets.
pub const DEFAULT_MARGIN_PX: f64 = 24.0;
/// Extra height added around a page-reported `content-size` (room for the page's stage padding, shadow and caption).
pub const DEFAULT_CONTENT_PADDING_PX: f64 = 24.0;
/// Layer-shell namespace used when the request does not set one.
pub const DEFAULT_NAMESPACE: &str = "rp-overlay";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/// wlr-layer-shell layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Background,
    Bottom,
    #[default]
    Top,
    Overlay,
}

impl Layer {
    pub const ALL: [Layer; 4] = [Layer::Background, Layer::Bottom, Layer::Top, Layer::Overlay];
}

/// Placement preset (`MediaPosition` in `@rp/shared`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    /// A spot chosen by the app (`randomX`/`randomY` fractions of the free space), always fully on the monitor.
    Random,
    #[default]
    Center,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Which monitor an overlay should live on. The canonical form is the object
/// `{ index?, name?, x?, y? }`; as a convenience a bare number is treated as an
/// index and a bare string as a name.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum MonitorSelector {
    Spec {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    Index(i64),
    Name(String),
}

// ---------------------------------------------------------------------------
// Requests (app → helper)
// ---------------------------------------------------------------------------

/// One line read from stdin.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    /// Optional correlation number, echoed on the reply.
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Hello {
        #[serde(default = "default_hello_version")]
        version: u32,
    },
    Monitors,
    Show(ShowParams),
    Update {
        id: String,
        #[serde(default)]
        patch: UpdatePatch,
    },
    Js {
        id: String,
        script: String,
    },
    Close {
        id: String,
    },
    CloseAll,
    Quit,
}

fn default_hello_version() -> u32 {
    PROTOCOL_VERSION
}

fn default_width() -> f64 {
    DEFAULT_WIDTH
}

fn default_margin() -> f64 {
    DEFAULT_MARGIN_PX
}
fn default_content_padding() -> f64 {
    DEFAULT_CONTENT_PADDING_PX
}

fn default_opacity() -> f64 {
    1.0
}

/// Parameters of a `show` request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowParams {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub layer: Layer,
    #[serde(default)]
    pub anchor: Anchor,
    #[serde(default = "default_margin")]
    pub margin_px: f64,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    /// Fractions (0..1) of the free space used by `anchor: "random"`; default 0.5 (centre).
    #[serde(default)]
    pub random_x: Option<f64>,
    #[serde(default)]
    pub random_y: Option<f64>,
    #[serde(default)]
    pub monitor: Option<MonitorSelector>,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default)]
    pub height: Option<f64>,
    /// Added to the page's reported content height when no explicit `height` was given. Default 24.
    #[serde(default = "default_content_padding")]
    pub content_padding: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub click_through: bool,
    #[serde(default)]
    pub namespace: Option<String>,
}

/// Fields of an `update` request. Absent (or `null`) fields keep their current value.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePatch {
    #[serde(default)]
    pub layer: Option<Layer>,
    #[serde(default)]
    pub anchor: Option<Anchor>,
    #[serde(default)]
    pub margin_px: Option<f64>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub random_x: Option<f64>,
    #[serde(default)]
    pub random_y: Option<f64>,
    #[serde(default)]
    pub monitor: Option<MonitorSelector>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub click_through: Option<bool>,
}

/// Parse one stdin line. Blank lines are reported as `Ok(None)`.
pub fn parse_line(line: &str) -> Result<Option<Request>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<Request>(trimmed)
        .map(Some)
        .map_err(|e| format!("invalid request: {e}"))
}

// ---------------------------------------------------------------------------
// Events (helper → app)
// ---------------------------------------------------------------------------

/// Monitor description (`MonitorInfo` in `@rp/shared`). Geometry is the work area in
/// logical pixels, in the global coordinate space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub index: usize,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
    pub has_cursor: bool,
}

impl MonitorInfo {
    /// Whether the logical point lies inside this monitor's work area.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x as f64
            && y >= self.y as f64
            && x < (self.x + self.width) as f64
            && y < (self.y + self.height) as f64
    }
}

/// Capabilities announced in `ready`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub layers: Vec<Layer>,
    pub opacity: bool,
    pub click_through: bool,
    pub monitor_selection: bool,
    pub exact_position: bool,
    pub video: bool,
}

impl Default for Features {
    fn default() -> Self {
        Features {
            layers: Layer::ALL.to_vec(),
            opacity: true,
            click_through: true,
            monitor_selection: true,
            exact_position: true,
            video: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "ev", rename_all = "camelCase")]
pub enum Event {
    Ready {
        version: u32,
        features: Features,
    },
    Monitors {
        monitors: Vec<MonitorInfo>,
    },
    Shown {
        id: String,
    },
    Updated {
        id: String,
    },
    #[serde(rename = "js-done")]
    JsDone {
        id: String,
    },
    Closed {
        id: String,
    },
    Message {
        id: String,
        payload: Value,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    Log {
        level: String,
        message: String,
    },
}

impl Event {
    pub fn ready() -> Event {
        Event::Ready {
            version: PROTOCOL_VERSION,
            features: Features::default(),
        }
    }

    pub fn error(id: Option<&str>, message: impl Into<String>) -> Event {
        Event::Error {
            id: id.map(str::to_owned),
            message: message.into(),
        }
    }
}

/// An event plus the echoed `seq` of the request that caused it (if any).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outgoing {
    #[serde(flatten)]
    pub event: Event,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

impl Outgoing {
    pub fn new(event: Event, seq: Option<u64>) -> Outgoing {
        Outgoing { event, seq }
    }

    /// Serialise as a single line (no trailing newline). Serialisation of these
    /// types cannot fail, so the fallback only guards against future changes.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!("{{\"ev\":\"error\",\"message\":\"failed to serialise event: {e}\"}}")
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Request {
        parse_line(line)
            .unwrap_or_else(|e| panic!("{line}: {e}"))
            .expect("non-empty request")
    }

    #[test]
    fn parses_hello_with_seq() {
        let r = parse(r#"{"op":"hello","version":1,"seq":7}"#);
        assert_eq!(r.seq, Some(7));
        assert_eq!(r.op, Op::Hello { version: 1 });
    }

    #[test]
    fn hello_version_defaults() {
        let r = parse(r#"{"op":"hello"}"#);
        assert_eq!(r.seq, None);
        assert_eq!(
            r.op,
            Op::Hello {
                version: PROTOCOL_VERSION
            }
        );
    }

    #[test]
    fn parses_monitors_close_all_and_quit() {
        assert_eq!(parse(r#"{"op":"monitors"}"#).op, Op::Monitors);
        assert_eq!(parse(r#"{"op":"closeAll","seq":2}"#).op, Op::CloseAll);
        assert_eq!(parse(r#"{"op":"quit"}"#).op, Op::Quit);
    }

    #[test]
    fn parses_full_show() {
        let r = parse(
            r#"{"op":"show","seq":3,"id":"m1","url":"http://127.0.0.1:1234/t/x/media.html#cmd=abc",
                "layer":"overlay","anchor":"bottom-right","marginPx":12,"x":0.5,"y":100,
                "monitor":{"name":"DP-1"},"width":640,"height":360,"opacity":0.8,
                "clickThrough":true,"namespace":"rp-test"}"#,
        );
        match r.op {
            Op::Show(s) => {
                assert_eq!(s.id, "m1");
                assert!(s.url.ends_with("#cmd=abc"));
                assert_eq!(s.layer, Layer::Overlay);
                assert_eq!(s.anchor, Anchor::BottomRight);
                assert_eq!(s.margin_px, 12.0);
                assert_eq!(s.x, Some(0.5));
                assert_eq!(s.y, Some(100.0));
                assert_eq!(
                    s.monitor,
                    Some(MonitorSelector::Spec {
                        index: None,
                        name: Some("DP-1".into()),
                        x: None,
                        y: None
                    })
                );
                assert_eq!(s.width, 640.0);
                assert_eq!(s.height, Some(360.0));
                assert_eq!(s.opacity, 0.8);
                assert!(s.click_through);
                assert_eq!(s.namespace.as_deref(), Some("rp-test"));
            }
            other => panic!("expected show, got {other:?}"),
        }
    }

    #[test]
    fn show_defaults() {
        let r = parse(r#"{"op":"show","id":"a","url":"http://x/"}"#);
        match r.op {
            Op::Show(s) => {
                assert_eq!(s.layer, Layer::Top);
                assert_eq!(s.anchor, Anchor::Center);
                assert_eq!(s.margin_px, DEFAULT_MARGIN_PX);
                assert_eq!(s.width, DEFAULT_WIDTH);
                assert_eq!(s.height, None);
                assert_eq!(s.opacity, 1.0);
                assert!(!s.click_through);
                assert_eq!(s.monitor, None);
                assert_eq!(s.namespace, None);
            }
            other => panic!("expected show, got {other:?}"),
        }
    }

    #[test]
    fn monitor_selector_accepts_scalar_forms() {
        let r = parse(r#"{"op":"show","id":"a","url":"u","monitor":1}"#);
        let Op::Show(s) = r.op else { panic!() };
        assert_eq!(s.monitor, Some(MonitorSelector::Index(1)));
        let r = parse(r#"{"op":"show","id":"a","url":"u","monitor":"HDMI-A-1"}"#);
        let Op::Show(s) = r.op else { panic!() };
        assert_eq!(s.monitor, Some(MonitorSelector::Name("HDMI-A-1".into())));
        let r = parse(r#"{"op":"show","id":"a","url":"u","monitor":{"x":10,"y":20}}"#);
        let Op::Show(s) = r.op else { panic!() };
        assert_eq!(
            s.monitor,
            Some(MonitorSelector::Spec {
                index: None,
                name: None,
                x: Some(10.0),
                y: Some(20.0)
            })
        );
    }

    #[test]
    fn parses_update_patch() {
        let r = parse(
            r#"{"op":"update","id":"m1","patch":{"opacity":0.5,"layer":"bottom","x":10,"clickThrough":false}}"#,
        );
        match r.op {
            Op::Update { id, patch } => {
                assert_eq!(id, "m1");
                assert_eq!(patch.opacity, Some(0.5));
                assert_eq!(patch.layer, Some(Layer::Bottom));
                assert_eq!(patch.x, Some(10.0));
                assert_eq!(patch.click_through, Some(false));
                assert_eq!(patch.width, None);
                assert_eq!(patch.anchor, None);
            }
            other => panic!("expected update, got {other:?}"),
        }
        // An empty / missing patch is fine.
        let r = parse(r#"{"op":"update","id":"m1"}"#);
        assert_eq!(
            r.op,
            Op::Update {
                id: "m1".into(),
                patch: UpdatePatch::default()
            }
        );
        // null == absent
        let r = parse(r#"{"op":"update","id":"m1","patch":{"height":null}}"#);
        assert_eq!(
            r.op,
            Op::Update {
                id: "m1".into(),
                patch: UpdatePatch::default()
            }
        );
    }

    #[test]
    fn parses_js_and_close() {
        let r = parse(r#"{"op":"js","id":"m1","script":"window.__rpMediaCommand('{}')","seq":9}"#);
        assert_eq!(
            r.op,
            Op::Js {
                id: "m1".into(),
                script: "window.__rpMediaCommand('{}')".into()
            }
        );
        assert_eq!(r.seq, Some(9));
        assert_eq!(
            parse(r#"{"op":"close","id":"m1"}"#).op,
            Op::Close { id: "m1".into() }
        );
    }

    #[test]
    fn blank_lines_are_skipped() {
        assert_eq!(parse_line("   \n"), Ok(None));
        assert_eq!(parse_line(""), Ok(None));
    }

    #[test]
    fn rejects_bad_requests() {
        let bad = [
            "not json",
            "[]",
            "42",
            r#"{"seq":1}"#,
            r#"{"op":"dance"}"#,
            r#"{"op":"show","url":"u"}"#,
            r#"{"op":"show","id":"a"}"#,
            r#"{"op":"show","id":"a","url":"u","layer":"middle"}"#,
            r#"{"op":"show","id":"a","url":"u","anchor":"left"}"#,
            r#"{"op":"show","id":"a","url":"u","width":"wide"}"#,
            r#"{"op":"update","patch":{}}"#,
            r#"{"op":"update","id":"a","patch":{"opacity":"half"}}"#,
            r#"{"op":"js","id":"a"}"#,
            r#"{"op":"close"}"#,
            r#"{"op":"hello","version":"one"}"#,
            r#"{"op":"hello","seq":-1}"#,
        ];
        for line in bad {
            assert!(parse_line(line).is_err(), "should reject: {line}");
        }
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let r = parse(r#"{"op":"show","id":"a","url":"u","future":true}"#);
        assert!(matches!(r.op, Op::Show(_)));
    }

    #[test]
    fn serialises_events() {
        let line = Outgoing::new(Event::ready(), Some(1)).to_line();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ev"], "ready");
        assert_eq!(v["version"], PROTOCOL_VERSION);
        assert_eq!(v["seq"], 1);
        assert_eq!(
            v["features"]["layers"],
            serde_json::json!(["background", "bottom", "top", "overlay"])
        );
        assert_eq!(v["features"]["clickThrough"], true);
        assert_eq!(v["features"]["exactPosition"], true);
        assert_eq!(v["features"]["video"], true);

        let line = Outgoing::new(Event::JsDone { id: "m1".into() }, None).to_line();
        assert_eq!(line, r#"{"ev":"js-done","id":"m1"}"#);

        let line = Outgoing::new(Event::error(None, "boom"), None).to_line();
        assert_eq!(line, r#"{"ev":"error","message":"boom"}"#);

        let line = Outgoing::new(Event::error(Some("m1"), "boom"), Some(4)).to_line();
        assert_eq!(line, r#"{"ev":"error","id":"m1","message":"boom","seq":4}"#);

        let mon = MonitorInfo {
            id: "0".into(),
            name: "DP-1".into(),
            index: 0,
            primary: true,
            x: 0,
            y: 0,
            width: 2560,
            height: 1400,
            scale: 1.0,
            has_cursor: true,
        };
        let line = Outgoing::new(
            Event::Monitors {
                monitors: vec![mon],
            },
            None,
        )
        .to_line();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["monitors"][0]["hasCursor"], true);
        assert_eq!(v["monitors"][0]["name"], "DP-1");

        let line = Outgoing::new(
            Event::Message {
                id: "m1".into(),
                payload: serde_json::json!({"type":"ended","id":"m1"}),
            },
            None,
        )
        .to_line();
        assert_eq!(
            line,
            r#"{"ev":"message","id":"m1","payload":{"id":"m1","type":"ended"}}"#
        );
    }

    #[test]
    fn monitor_contains_point() {
        let mon = MonitorInfo {
            id: "1".into(),
            name: "HDMI-A-1".into(),
            index: 1,
            primary: false,
            x: 2560,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            has_cursor: false,
        };
        assert!(mon.contains(2560.0, 0.0));
        assert!(mon.contains(4479.0, 1079.0));
        assert!(!mon.contains(4480.0, 0.0));
        assert!(!mon.contains(100.0, 100.0));
    }
}
