//! The font families installed on this machine, for Settings › Appearance.

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct Fonts {
    /// Every family, sorted without regard to case.
    pub all: Vec<String>,
    /// The monospaced ones among them.
    pub mono: Vec<String>,
}

/// One entry per family from (family, is a monospaced face) pairs. Names that start with `.` are
/// macOS's private system fonts and those with `@` are Windows's sideways fonts for vertical text.
fn collect(faces: impl Iterator<Item = (String, bool)>) -> Fonts {
    let mut families: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for (name, mono) in faces {
        if name.is_empty() || name.starts_with(['.', '@']) {
            continue;
        }
        let family = families.entry(name.to_lowercase()).or_insert((name, false));
        family.1 |= mono;
    }
    let mono = families.values().filter(|f| f.1).map(|f| f.0.clone()).collect();
    Fonts { all: families.into_values().map(|f| f.0).collect(), mono }
}

#[tauri::command]
pub async fn font_list() -> Result<Fonts, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // A face's first family name is its English one.
        collect(db.faces().filter_map(|f| Some((f.families.first()?.0.clone(), f.monospaced))))
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts(faces: &[(&str, bool)]) -> Fonts {
        collect(faces.iter().map(|(n, m)| (n.to_string(), *m)))
    }

    #[test]
    fn one_sorted_entry_per_family() {
        let f = fonts(&[("Verdana", false), ("arial", false), ("Verdana", false), ("Consolas", true), ("VERDANA", false)]);
        assert_eq!(f.all, ["arial", "Consolas", "Verdana"]);
        assert_eq!(f.mono, ["Consolas"]);
    }

    #[test]
    fn a_family_is_monospaced_if_any_face_is() {
        assert_eq!(fonts(&[("Mixed", false), ("Mixed", true)]).mono, ["Mixed"]);
    }

    #[test]
    fn leaves_out_private_and_vertical_fonts() {
        let f = fonts(&[(".SF NS", false), ("@MS Gothic", true), ("", false), ("Inter", false)]);
        assert_eq!(f.all, ["Inter"]);
        assert!(f.mono.is_empty());
    }
}
