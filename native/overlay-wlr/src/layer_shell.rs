//! Minimal safe bindings to `libgtk-layer-shell` (`gtk-layer-shell-0 >= 0.6`).
//!
//! The `gtk-layer-shell` crate on crates.io is unmaintained and remains pinned to the
//! `gtk 0.18` / `glib 0.18` family (which carries GHSA-wrw7-89jp-8q8g). We only use a
//! dozen functions from `gtk-layer-shell.h`, so binding them directly lets the crate
//! move to `gtk 0.19` / `glib 0.22` without changing any system library dependency.

use std::ffi::{c_char, c_int};

use gdk::ffi::GdkMonitor;
use glib::ffi::{gboolean, guint};
use glib::translate::{from_glib, IntoGlib, ToGlibPtr};
use gtk::ffi::GtkWindow;

/// Layer-shell stacking layer (`GtkLayerShellLayer`).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Background = 0,
    Bottom = 1,
    Top = 2,
    Overlay = 3,
}

/// Layer-shell screen edge (`GtkLayerShellEdge`).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Left = 0,
    Right = 1,
    Top = 2,
    Bottom = 3,
}

/// Layer-shell keyboard interactivity mode (`GtkLayerShellKeyboardMode`).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyboardMode {
    None = 0,
    #[allow(dead_code)]
    Exclusive = 1,
    #[allow(dead_code)]
    OnDemand = 2,
}

extern "C" {
    fn gtk_layer_get_major_version() -> guint;
    fn gtk_layer_get_minor_version() -> guint;
    fn gtk_layer_get_micro_version() -> guint;
    fn gtk_layer_is_supported() -> gboolean;
    fn gtk_layer_get_protocol_version() -> guint;
    fn gtk_layer_init_for_window(window: *mut GtkWindow);
    fn gtk_layer_set_namespace(window: *mut GtkWindow, name_space: *const c_char);
    fn gtk_layer_set_layer(window: *mut GtkWindow, layer: Layer);
    fn gtk_layer_set_monitor(window: *mut GtkWindow, monitor: *mut GdkMonitor);
    fn gtk_layer_set_anchor(window: *mut GtkWindow, edge: Edge, anchor_to_edge: gboolean);
    fn gtk_layer_set_margin(window: *mut GtkWindow, edge: Edge, margin_size: c_int);
    fn gtk_layer_set_exclusive_zone(window: *mut GtkWindow, exclusive_zone: c_int);
    fn gtk_layer_set_keyboard_mode(window: *mut GtkWindow, mode: KeyboardMode);
}

pub fn major_version() -> u32 {
    unsafe { gtk_layer_get_major_version() }
}

pub fn minor_version() -> u32 {
    unsafe { gtk_layer_get_minor_version() }
}

pub fn micro_version() -> u32 {
    unsafe { gtk_layer_get_micro_version() }
}

pub fn is_supported() -> bool {
    unsafe { from_glib(gtk_layer_is_supported()) }
}

pub fn protocol_version() -> u32 {
    unsafe { gtk_layer_get_protocol_version() }
}

/// Layer-shell operations on a [`gtk::Window`].
pub trait LayerShell {
    fn init_layer_shell(&self);
    fn set_namespace(&self, namespace: &str);
    fn set_layer(&self, layer: Layer);
    fn set_monitor(&self, monitor: &gdk::Monitor);
    fn set_anchor(&self, edge: Edge, anchor_to_edge: bool);
    fn set_layer_shell_margin(&self, edge: Edge, margin_size: i32);
    fn set_exclusive_zone(&self, exclusive_zone: i32);
    fn set_keyboard_mode(&self, mode: KeyboardMode);
}

impl LayerShell for gtk::Window {
    fn init_layer_shell(&self) {
        unsafe { gtk_layer_init_for_window(self.to_glib_none().0) }
    }

    fn set_namespace(&self, namespace: &str) {
        unsafe { gtk_layer_set_namespace(self.to_glib_none().0, namespace.to_glib_none().0) }
    }

    fn set_layer(&self, layer: Layer) {
        unsafe { gtk_layer_set_layer(self.to_glib_none().0, layer) }
    }

    fn set_monitor(&self, monitor: &gdk::Monitor) {
        unsafe { gtk_layer_set_monitor(self.to_glib_none().0, monitor.to_glib_none().0) }
    }

    fn set_anchor(&self, edge: Edge, anchor_to_edge: bool) {
        unsafe { gtk_layer_set_anchor(self.to_glib_none().0, edge, anchor_to_edge.into_glib()) }
    }

    fn set_layer_shell_margin(&self, edge: Edge, margin_size: i32) {
        unsafe { gtk_layer_set_margin(self.to_glib_none().0, edge, margin_size) }
    }

    fn set_exclusive_zone(&self, exclusive_zone: i32) {
        unsafe { gtk_layer_set_exclusive_zone(self.to_glib_none().0, exclusive_zone) }
    }

    fn set_keyboard_mode(&self, mode: KeyboardMode) {
        unsafe { gtk_layer_set_keyboard_mode(self.to_glib_none().0, mode) }
    }
}
