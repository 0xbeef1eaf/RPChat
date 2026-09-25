//! One GTK window per overlay: a transparent layer-shell surface hosting a WebKitGTK
//! web view that renders the app's media page. Applies [`OverlayPlan`]s and relays the
//! page's `postMessage` reports as `message` events.
//!
//! Everything here runs on the GTK main thread.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use glib::translate::ToGlibPtr;
use gtk::prelude::*;
use gtk_layer_shell::{Edge, KeyboardMode, LayerShell};
use webkit2gtk::{
    LoadEvent, SettingsExt, UserContentInjectedFrames, UserContentManager, UserContentManagerExt,
    UserScript, UserScriptInjectionTime, WebView, WebViewExt,
};

use crate::events::EventSink;
use crate::monitors::MonitorSource;
use crate::plan::{plan, OverlayPlan, OverlaySettings};
use crate::protocol::{Event, Layer, ShowParams, UpdatePatch};

/// Name of the script message handler the page posts to
/// (`window.webkit.messageHandlers.rp.postMessage(...)`).
const MESSAGE_HANDLER: &str = "rp";

/// Injected at document start so the page can detect helper mode.
const HELPER_MARKER_SCRIPT: &str = "window.__rpHelper = true;";

/// Where the synthetic click below lands: the page's own margin, clear of the media stage.
const ACTIVATION_POINT: f64 = 1.0;

/// Hand the page the user gesture WebKit wants before it will play a video.
///
/// `media-playback-requires-user-gesture: false` (set on the view) does not lift that requirement:
/// `video.play()` rejects with `NotAllowedError` until the page has seen a pointer event, while
/// `audio.play()` is allowed either way — which is why sound has always worked and video never did.
/// Without this the page is left showing WebKit's play-button placeholder, and its rejected `play()`
/// is reported to the app, which closes the overlay on the first error: an empty player that
/// vanishes a moment after it opens, whatever `loop`/`closeOnEnd` asked for.
///
/// The events go straight to the widget, so the compositor never sees them and a click-through
/// surface stays click-through. They land at (1, 1) — the page's margin, outside the stage — so no
/// item's click handler runs and no `media-clicked` is reported for a click the user never made.
fn grant_user_activation(view: &WebView, id: &str) {
    let Some(window) = view.window() else {
        log_debug!("[{}] no gdk window yet; playback activation deferred", id);
        return;
    };
    let device = gdk::Display::default()
        .and_then(|display| display.default_seat())
        .and_then(|seat| seat.pointer());
    let time = gtk::current_event_time();
    for (kind, state) in [
        (gdk::EventType::ButtonPress, gdk::ModifierType::empty()),
        (
            gdk::EventType::ButtonRelease,
            gdk::ModifierType::BUTTON1_MASK,
        ),
    ] {
        let mut event = gdk::Event::new(kind);
        event.set_device(device.as_ref());
        if let Some(button) = event.downcast_mut::<gdk::EventButton>() {
            let raw = button.as_mut();
            // The event owns this reference and drops it when it is freed.
            raw.window = window.to_glib_full();
            raw.send_event = 1;
            raw.time = time;
            raw.x = ACTIVATION_POINT;
            raw.y = ACTIVATION_POINT;
            raw.x_root = ACTIVATION_POINT;
            raw.y_root = ACTIVATION_POINT;
            raw.button = 1;
            raw.state = state.bits();
        }
        view.event(&event);
    }
    log_debug!("[{}] playback activation delivered", id);
}

fn shell_layer(layer: Layer) -> gtk_layer_shell::Layer {
    match layer {
        Layer::Background => gtk_layer_shell::Layer::Background,
        Layer::Bottom => gtk_layer_shell::Layer::Bottom,
        Layer::Top => gtk_layer_shell::Layer::Top,
        Layer::Overlay => gtk_layer_shell::Layer::Overlay,
    }
}

pub struct Overlay {
    id: String,
    window: gtk::Window,
    webview: WebView,
    settings: RefCell<OverlaySettings>,
    last_plan: RefCell<Option<OverlayPlan>>,
    monitors: Rc<dyn MonitorSource>,
    sink: EventSink,
    /// `seq` of the `show` request, echoed on `shown`.
    show_seq: Cell<Option<u64>>,
    shown_sent: Cell<bool>,
    /// `seq` of the `close` request (if any), echoed on `closed`.
    close_seq: Cell<Option<u64>>,
    closed_sent: Cell<bool>,
    /// False once the window has been destroyed (by us or by the compositor).
    alive: Cell<bool>,
}

impl Overlay {
    /// Build the window + web view, apply the initial plan and show it. `shown` is
    /// emitted from the window's `map` signal.
    pub fn create(
        show: &ShowParams,
        seq: Option<u64>,
        sink: EventSink,
        monitors: Rc<dyn MonitorSource>,
    ) -> Rc<Overlay> {
        let settings = OverlaySettings::from_show(show);

        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title(&format!("rp-overlay:{}", show.id));
        window.set_decorated(false);
        window.set_app_paintable(true);
        window.set_accept_focus(false);
        window.set_focus_on_map(false);
        window.set_skip_taskbar_hint(true);
        window.set_type_hint(gdk::WindowTypeHint::Notification);
        if let Some(visual) = WidgetExt::screen(&window).and_then(|s| s.rgba_visual()) {
            window.set_visual(Some(&visual));
        }

        // Layer-shell setup must happen before the window is realised.
        window.init_layer_shell();
        window.set_namespace(&settings.namespace);
        window.set_exclusive_zone(0);
        window.set_keyboard_mode(KeyboardMode::None);

        // Web view with the `rp` message handler and the helper marker script.
        let ucm = UserContentManager::new();
        ucm.add_script(&UserScript::new(
            HELPER_MARKER_SCRIPT,
            UserContentInjectedFrames::TopFrame,
            UserScriptInjectionTime::Start,
            &[],
            &[],
        ));
        if !ucm.register_script_message_handler(MESSAGE_HANDLER) {
            log_warn!(
                "[{}] could not register script message handler '{}'",
                show.id,
                MESSAGE_HANDLER
            );
        }
        let webview = WebView::with_user_content_manager(&ucm);
        let web_settings = webkit2gtk::Settings::new();
        web_settings.set_enable_javascript(true);
        web_settings.set_enable_developer_extras(false);
        web_settings.set_media_playback_requires_user_gesture(false);
        web_settings.set_enable_media(true);
        webview.set_settings(&web_settings);
        webview.set_background_color(&gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
        webview.set_can_focus(false);
        window.add(&webview);

        let overlay = Rc::new(Overlay {
            id: show.id.clone(),
            window,
            webview,
            settings: RefCell::new(settings),
            last_plan: RefCell::new(None),
            monitors,
            sink,
            show_seq: Cell::new(seq),
            shown_sent: Cell::new(false),
            close_seq: Cell::new(None),
            closed_sent: Cell::new(false),
            alive: Cell::new(true),
        });
        overlay.connect_signals(&ucm);
        overlay.apply_plan();

        log_info!(
            "[{}] show {} (layer {:?})",
            overlay.id,
            show.url,
            show.layer
        );
        overlay.webview.load_uri(&show.url);
        overlay.window.show_all();
        overlay
    }

    pub fn is_alive(&self) -> bool {
        self.alive.get()
    }

    fn connect_signals(self: &Rc<Self>, ucm: &UserContentManager) {
        let weak = Rc::downgrade(self);

        // shown: once the window is mapped.
        let w = weak.clone();
        self.window.connect_map(move |_| {
            if let Some(o) = w.upgrade() {
                o.on_mapped();
            }
        });

        // closed: whenever the window goes away (our close, or the compositor's).
        let w = weak.clone();
        self.window.connect_destroy(move |_| {
            if let Some(o) = w.upgrade() {
                o.on_destroyed();
            }
        });

        // Re-apply the input shape after realisation (GTK only stores it before).
        let w = weak.clone();
        self.window.connect_realize(move |_| {
            if let Some(o) = w.upgrade() {
                let click_through = o
                    .last_plan
                    .borrow()
                    .as_ref()
                    .map(|p| p.click_through)
                    .unwrap_or(false);
                o.apply_input_shape(click_through);
            }
        });

        // Page → app messages.
        let w = weak.clone();
        ucm.connect_script_message_received(Some(MESSAGE_HANDLER), move |_, result| {
            if let Some(o) = w.upgrade() {
                o.on_script_message(result);
            }
        });

        // Page load diagnostics.
        let w = weak.clone();
        self.webview
            .connect_load_failed(move |_, _event, uri, error| {
                if let Some(o) = w.upgrade() {
                    o.sink.emit(
                        Event::error(Some(&o.id), format!("failed to load {uri}: {error}")),
                        None,
                    );
                }
                false
            });
        let w = weak.clone();
        self.webview.connect_load_changed(move |view, event| {
            let Some(o) = w.upgrade() else { return };
            // Committed *and* Finished: the page calls play() as soon as React mounts, which can be
            // either side of Finished, and an activation that arrives late is only a click on a
            // page that already has one. See `grant_user_activation`.
            match event {
                LoadEvent::Committed => grant_user_activation(view, &o.id),
                LoadEvent::Finished => {
                    grant_user_activation(view, &o.id);
                    log_debug!("[{}] page load finished", o.id);
                }
                _ => {}
            }
        });
        let w = weak.clone();
        self.webview
            .connect_web_process_terminated(move |_, reason| {
                if let Some(o) = w.upgrade() {
                    o.sink.emit(
                        Event::error(Some(&o.id), format!("web process terminated: {reason:?}")),
                        None,
                    );
                }
            });
        // The page may call window.close(); treat it like a close request.
        let w = weak;
        self.webview.connect_close(move |_| {
            if let Some(o) = w.upgrade() {
                log_info!("[{}] page requested close", o.id);
                o.close(None);
            }
        });
    }

    fn on_mapped(&self) {
        if self.shown_sent.replace(true) {
            return;
        }
        log_debug!("[{}] mapped", self.id);
        self.sink.emit(
            Event::Shown {
                id: self.id.clone(),
            },
            self.show_seq.take(),
        );
    }

    fn on_destroyed(&self) {
        self.alive.set(false);
        if self.closed_sent.replace(true) {
            return;
        }
        log_info!("[{}] closed", self.id);
        self.sink.emit(
            Event::Closed {
                id: self.id.clone(),
            },
            self.close_seq.take(),
        );
    }

    fn on_script_message(&self, result: &webkit2gtk::JavascriptResult) {
        let payload = match result.js_value() {
            Some(value) => js_value_to_json(&value),
            None => serde_json::Value::Null,
        };
        log_debug!("[{}] message {}", self.id, payload);
        // content-size: adopt the reported height when the app gave none.
        if payload.get("type").and_then(|t| t.as_str()) == Some("content-size") {
            let width = payload.get("width").and_then(|v| v.as_f64());
            let height = payload.get("height").and_then(|v| v.as_f64());
            if let (Some(width), Some(height)) = (width, height) {
                let changed = self.settings.borrow_mut().set_content_size(width, height);
                if changed {
                    self.apply_plan();
                }
            }
        }
        self.sink.emit(
            Event::Message {
                id: self.id.clone(),
                payload,
            },
            None,
        );
    }

    /// Merge an `update` patch and re-apply. Emits `updated`.
    pub fn update(&self, patch: &UpdatePatch, seq: Option<u64>) {
        self.settings.borrow_mut().apply(patch);
        self.apply_plan();
        self.sink.emit(
            Event::Updated {
                id: self.id.clone(),
            },
            seq,
        );
    }

    /// Run `script` in the page; emits `js-done` (or `error`) when it completes.
    pub fn run_js(&self, script: &str, seq: Option<u64>) {
        let sink = self.sink.clone();
        let id = self.id.clone();
        // `run_javascript` is deprecated since WebKitGTK 2.40 in favour of
        // `evaluate_javascript`, but it is still shipped and is what the spec names.
        #[allow(deprecated)]
        self.webview
            .run_javascript(
                script,
                None::<&gtk::gio::Cancellable>,
                move |result| match result {
                    Ok(_) => sink.emit(Event::JsDone { id }, seq),
                    Err(err) => sink.emit(
                        Event::error(Some(&id), format!("script failed: {err}")),
                        seq,
                    ),
                },
            );
    }

    /// Destroy the window. `closed` is emitted from the destroy handler.
    pub fn close(&self, seq: Option<u64>) {
        if !self.alive.get() {
            if !self.closed_sent.replace(true) {
                self.sink.emit(
                    Event::Closed {
                        id: self.id.clone(),
                    },
                    seq,
                );
            }
            return;
        }
        if seq.is_some() {
            self.close_seq.set(seq);
        }
        self.alive.set(false);
        self.webview.stop_loading();
        // SAFETY: the window is not touched again after this point; `alive` is false
        // and the manager drops its reference.
        unsafe {
            self.window.destroy();
        }
    }

    /// Compute the plan for the current settings and push it into GTK/layer-shell.
    fn apply_plan(&self) {
        let monitors = self.monitors.monitors();
        let next = plan(&self.settings.borrow(), &monitors);
        let previous = self.last_plan.borrow().clone();
        if previous.as_ref() == Some(&next) {
            return;
        }
        log_debug!("[{}] plan {:?}", self.id, next);
        let w = &self.window;

        w.set_layer(shell_layer(next.layer));
        w.set_anchor(Edge::Top, next.anchors.top);
        w.set_anchor(Edge::Bottom, next.anchors.bottom);
        w.set_anchor(Edge::Left, next.anchors.left);
        w.set_anchor(Edge::Right, next.anchors.right);
        w.set_layer_shell_margin(Edge::Top, next.margins.top);
        w.set_layer_shell_margin(Edge::Bottom, next.margins.bottom);
        w.set_layer_shell_margin(Edge::Left, next.margins.left);
        w.set_layer_shell_margin(Edge::Right, next.margins.right);

        let monitor_changed =
            previous.as_ref().map(|p| p.monitor_index) != Some(next.monitor_index);
        if monitor_changed {
            match next.monitor_index.and_then(gdk_monitor) {
                Some(monitor) => w.set_monitor(&monitor),
                None => {
                    if next.monitor_index.is_some() {
                        log_warn!(
                            "[{}] GDK monitor {:?} not found; using default",
                            self.id,
                            next.monitor_index
                        );
                    }
                }
            }
        }

        let size_changed =
            previous.as_ref().map(|p| (p.width, p.height)) != Some((next.width, next.height));
        if size_changed {
            w.set_size_request(next.width, next.height);
            w.set_default_size(next.width, next.height);
            self.webview.set_size_request(next.width, next.height);
            if w.is_realized() {
                w.resize(next.width, next.height);
            }
        }

        w.set_opacity(next.opacity);
        self.apply_input_shape(next.click_through);

        *self.last_plan.borrow_mut() = Some(next);
    }

    fn apply_input_shape(&self, click_through: bool) {
        if click_through {
            // An empty input region: every pointer event falls through to what is below.
            let empty = cairo::Region::create();
            self.window.input_shape_combine_region(Some(&empty));
        } else {
            self.window.input_shape_combine_region(None);
        }
        // Overlays never take keyboard focus in either mode.
        self.window.set_keyboard_mode(KeyboardMode::None);
    }
}

/// Convert a JSC value posted by the page into JSON. The page posts JSON *strings*
/// (`postMessage(JSON.stringify(event))`), which are parsed; any other value is
/// serialised through JSC's own JSON conversion.
fn js_value_to_json(value: &javascriptcore::Value) -> serde_json::Value {
    use javascriptcore::ValueExt;
    if value.is_string() {
        let text = value.to_str().to_string();
        return serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    }
    if value.is_null() || value.is_undefined() {
        return serde_json::Value::Null;
    }
    value
        .to_json(0)
        .and_then(|json| serde_json::from_str(json.as_str()).ok())
        .unwrap_or_else(|| serde_json::Value::String(value.to_str().to_string()))
}

fn gdk_monitor(index: usize) -> Option<gdk::Monitor> {
    let display = gdk::Display::default()?;
    let index = i32::try_from(index).ok()?;
    if index >= display.n_monitors() {
        return None;
    }
    display.monitor(index)
}

/// All live overlays, keyed by id.
pub struct OverlayManager {
    overlays: HashMap<String, Rc<Overlay>>,
    sink: EventSink,
    monitors: Rc<dyn MonitorSource>,
}

impl OverlayManager {
    pub fn new(sink: EventSink, monitors: Rc<dyn MonitorSource>) -> OverlayManager {
        OverlayManager {
            overlays: HashMap::new(),
            sink,
            monitors,
        }
    }

    /// Drop entries whose window was destroyed behind our back (compositor closed it).
    fn prune(&mut self) {
        self.overlays.retain(|_, o| o.is_alive());
    }

    pub fn show(&mut self, show: &ShowParams, seq: Option<u64>) {
        self.prune();
        if let Some(existing) = self.overlays.remove(&show.id) {
            log_info!("[{}] show for an existing id; replacing", show.id);
            existing.close(None);
        }
        let overlay = Overlay::create(show, seq, self.sink.clone(), self.monitors.clone());
        self.overlays.insert(show.id.clone(), overlay);
    }

    pub fn update(&mut self, id: &str, patch: &UpdatePatch, seq: Option<u64>) {
        self.prune();
        match self.overlays.get(id) {
            Some(o) => o.update(patch, seq),
            None => self.unknown(id, seq),
        }
    }

    pub fn js(&mut self, id: &str, script: &str, seq: Option<u64>) {
        self.prune();
        match self.overlays.get(id) {
            Some(o) => o.run_js(script, seq),
            None => self.unknown(id, seq),
        }
    }

    pub fn close(&mut self, id: &str, seq: Option<u64>) {
        self.prune();
        match self.overlays.remove(id) {
            Some(o) => o.close(seq),
            None => self.unknown(id, seq),
        }
    }

    /// Close every overlay; one `closed` per overlay (the first also echoes `seq`).
    pub fn close_all(&mut self, seq: Option<u64>) {
        self.prune();
        let mut ids: Vec<String> = self.overlays.keys().cloned().collect();
        ids.sort();
        let mut seq = seq;
        for id in ids {
            if let Some(o) = self.overlays.remove(&id) {
                o.close(seq.take());
            }
        }
    }

    /// Number of overlays currently tracked.
    pub fn len(&self) -> usize {
        self.overlays.len()
    }

    fn unknown(&self, id: &str, seq: Option<u64>) {
        self.sink.emit(
            Event::error(Some(id), format!("unknown overlay id '{id}'")),
            seq,
        );
    }
}
