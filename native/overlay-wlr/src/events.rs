//! Serialised event output: one JSON object per line on stdout, written under a mutex
//! and flushed after every line so the app sees events immediately.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::protocol::{Event, Outgoing};

#[derive(Clone)]
pub struct EventSink {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    broken: Arc<AtomicBool>,
}

impl EventSink {
    pub fn new(writer: Box<dyn Write + Send>) -> EventSink {
        EventSink { writer: Arc::new(Mutex::new(writer)), broken: Arc::new(AtomicBool::new(false)) }
    }

    pub fn stdout() -> EventSink {
        EventSink::new(Box::new(std::io::stdout()))
    }

    /// Write one event line and flush. A failed write (the app went away) marks the
    /// sink as broken; callers poll [`EventSink::is_broken`] to shut down.
    pub fn emit(&self, event: Event, seq: Option<u64>) {
        let line = Outgoing::new(event, seq).to_line();
        let result = {
            let mut guard = match self.writer.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.write_all(line.as_bytes()).and_then(|_| guard.write_all(b"\n")).and_then(|_| guard.flush())
        };
        if let Err(err) = result {
            if !self.broken.swap(true, Ordering::SeqCst) {
                eprintln!("rp-overlay-wlr: stdout closed ({err}); shutting down");
            }
        }
    }

    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_one_line_per_event() {
        let cap = Capture::default();
        let sink = EventSink::new(Box::new(cap.clone()));
        sink.emit(Event::Shown { id: "a".into() }, Some(1));
        sink.emit(Event::Closed { id: "a".into() }, None);
        let out = String::from_utf8(cap.0.lock().unwrap().clone()).unwrap();
        assert_eq!(out, "{\"ev\":\"shown\",\"id\":\"a\",\"seq\":1}\n{\"ev\":\"closed\",\"id\":\"a\"}\n");
        assert!(!sink.is_broken());
    }

    #[test]
    fn broken_pipe_marks_sink() {
        let sink = EventSink::new(Box::new(Broken));
        sink.emit(Event::ready(), None);
        assert!(sink.is_broken());
    }
}
