//! Monitor enumeration. `plan.rs` and `--self-test` only see the [`MonitorSource`]
//! trait, so they can run against fixtures without a display; the real
//! implementation ([`GdkMonitors`]) asks GDK.

use crate::protocol::MonitorInfo;

/// Anything that can list the current monitors.
pub trait MonitorSource {
    fn monitors(&self) -> Vec<MonitorInfo>;
}

/// A fixed monitor list (tests, `--self-test`).
pub struct FixtureMonitors(pub Vec<MonitorInfo>);

impl MonitorSource for FixtureMonitors {
    fn monitors(&self) -> Vec<MonitorInfo> {
        self.0.clone()
    }
}

/// Two monitors side by side: a primary 2560x1440 (work area 2560x1400 below a 40px bar)
/// holding the cursor, and a 1920x1080 secondary to its right.
pub fn fixture_monitors() -> Vec<MonitorInfo> {
    vec![
        MonitorInfo {
            id: "0".into(),
            name: "DP-1".into(),
            index: 0,
            primary: true,
            x: 0,
            y: 40,
            width: 2560,
            height: 1400,
            scale: 1.0,
            has_cursor: true,
        },
        MonitorInfo {
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
        },
    ]
}

/// Monitors from the default GDK display. Must be used on the GTK main thread after
/// `gtk::init()`.
pub struct GdkMonitors;

impl MonitorSource for GdkMonitors {
    fn monitors(&self) -> Vec<MonitorInfo> {
        use gdk::prelude::*;

        let Some(display) = gdk::Display::default() else {
            return Vec::new();
        };
        let cursor = display
            .default_seat()
            .and_then(|seat| seat.pointer())
            .map(|pointer| {
                let (_screen, x, y) = pointer.position();
                (x, y)
            });

        let count = display.n_monitors().max(0);
        let mut out = Vec::with_capacity(count as usize);
        let mut any_primary = false;
        for i in 0..count {
            let Some(monitor) = display.monitor(i) else {
                continue;
            };
            let work = monitor.workarea();
            let geometry = monitor.geometry();
            let name = monitor
                .model()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("monitor-{i}"));
            let primary = monitor.is_primary();
            any_primary |= primary;
            let has_cursor = cursor
                .map(|(cx, cy)| {
                    cx >= geometry.x()
                        && cy >= geometry.y()
                        && cx < geometry.x() + geometry.width()
                        && cy < geometry.y() + geometry.height()
                })
                .unwrap_or(false);
            out.push(MonitorInfo {
                id: i.to_string(),
                name,
                index: i as usize,
                primary,
                x: work.x(),
                y: work.y(),
                width: work.width(),
                height: work.height(),
                scale: monitor.scale_factor() as f64,
                has_cursor,
            });
        }
        if !any_primary {
            // GDK on Wayland rarely marks a primary monitor; treat index 0 as primary
            // like the other backends do.
            if let Some(first) = out.first_mut() {
                first.primary = true;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_is_consistent() {
        let m = fixture_monitors();
        assert_eq!(m.len(), 2);
        assert_eq!(m.iter().filter(|m| m.primary).count(), 1);
        assert_eq!(m.iter().filter(|m| m.has_cursor).count(), 1);
        for (i, mon) in m.iter().enumerate() {
            assert_eq!(mon.index, i);
            assert_eq!(mon.id, i.to_string());
        }
        assert_eq!(FixtureMonitors(m.clone()).monitors(), m);
    }
}
