//! Types text into the focused field of another app with `SendInput` and `KEYEVENTF_UNICODE`,
//! and probes the foreground window that would receive it.
//!
//! The clipboard is never used. Control characters are typed as spaces, so a line can never
//! press Enter or Tab in the target (Enter would send a chat message).

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The window that would receive typed keys right now.
#[napi(object)]
pub struct ForegroundTarget {
    pub window_handle: i64,
    /// The focused control of the foreground window's GUI thread, when it reports one.
    pub focus_handle: Option<i64>,
    pub process_id: u32,
    /// Executable file name with its extension, such as `notepad.exe`.
    pub process_name: Option<String>,
    pub is_own_process: bool,
    /// A menu or popup menu is open, so keys would go to the menu.
    pub menu_open: bool,
    /// Shift, Ctrl, Alt or a Win key is held, so keys would become shortcuts.
    pub modifiers_held: bool,
    /// Higher integrity than ours, or unknown: UIPI would drop the keys without telling us.
    pub blocked: bool,
}

/// Key events delivered by `SendInput` versus the number it was given.
#[napi(object)]
pub struct TypeTextResult {
    pub sent: u32,
    pub expected: u32,
}

/// One keyboard event of a typed string: a UTF-16 code unit going down or up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnicodeKey {
    pub unit: u16,
    pub key_up: bool,
}

impl UnicodeKey {
    const fn down(unit: u16) -> Self {
        Self {
            unit,
            key_up: false,
        }
    }

    const fn up(unit: u16) -> Self {
        Self { unit, key_up: true }
    }
}

/// Control characters and line breaks become spaces: a typed line never presses Enter or Tab.
fn typed_char(c: char) -> char {
    if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
        ' '
    } else {
        c
    }
}

/// The keyboard events that type `text`, in order. Pure, so it is tested without the OS.
///
/// A surrogate pair goes down as high then low and comes up in the same order; apps that
/// assemble the pair on key-down see both halves before any key-up.
pub(crate) fn encode_keys(text: &str) -> Vec<UnicodeKey> {
    // UTF-8 never has fewer bytes than UTF-16 has units, so this holds two events per unit.
    let mut keys = Vec::with_capacity(text.len() * 2);
    let mut buf = [0u16; 2];
    for c in text.chars() {
        match *typed_char(c).encode_utf16(&mut buf) {
            [unit] => keys.extend([UnicodeKey::down(unit), UnicodeKey::up(unit)]),
            [high, low] => keys.extend([
                UnicodeKey::down(high),
                UnicodeKey::down(low),
                UnicodeKey::up(high),
                UnicodeKey::up(low),
            ]),
            // `encode_utf16` always yields one or two units.
            _ => {}
        }
    }
    keys
}

/// UIPI drops input sent to a process with a higher integrity level, and an unknown level
/// is treated the same way so the caller never types blind.
pub(crate) fn is_blocked(own_level: Option<u32>, target_level: Option<u32>) -> bool {
    match (own_level, target_level) {
        (Some(own), Some(target)) => target > own,
        _ => true,
    }
}

/// File name of a full image path, extension kept.
pub(crate) fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

#[cfg(windows)]
mod imp {
    use super::{encode_keys, file_name, is_blocked, ForegroundTarget, TypeTextResult, UnicodeKey};
    use napi::bindgen_prelude::*;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
        TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
        GUI_INMENUMODE, GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE,
    };

    /// Tags every event we inject (`dwExtraInfo`), so our own keys can be told apart later.
    const INJECTED_MARKER: usize = 0x564F_5A41;

    const MODIFIERS: [VIRTUAL_KEY; 5] = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN];

    const IMAGE_NAME_CHARS: usize = 32_768;

    fn to_input(key: &UnicodeKey) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if key.key_up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: key.unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: INJECTED_MARKER,
                },
            },
        }
    }

    pub fn type_text(text: &str) -> Result<TypeTextResult> {
        let keys = encode_keys(text);
        if keys.is_empty() {
            return Ok(TypeTextResult {
                sent: 0,
                expected: 0,
            });
        }
        let expected = u32::try_from(keys.len())
            .map_err(|_| Error::from_reason("text is too long to type in one call"))?;
        let inputs: Vec<INPUT> = keys.iter().map(to_input).collect();
        // One call for the whole line: the OS inserts it without the user's keys in between.
        // SAFETY: `inputs` is a live slice of initialized keyboard INPUTs and the size matches.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        Ok(TypeTextResult { sent, expected })
    }

    /// The RID of the token's mandatory label (0x2000 medium, 0x3000 high, ...).
    fn token_integrity_level(token: HANDLE) -> Option<u32> {
        let mut len = 0u32;
        // The first call only reports the size, failing with ERROR_INSUFFICIENT_BUFFER.
        // SAFETY: no buffer is passed; `len` is a live out pointer.
        let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len) };
        if (len as usize) < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() {
            return None;
        }
        // u64 storage keeps the label's pointer field aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` holds at least `len` writable bytes.
        unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buf.as_mut_ptr().cast()),
                len,
                &mut len,
            )
        }
        .ok()?;
        // SAFETY: the call above wrote a TOKEN_MANDATORY_LABEL at the start of `buf`, and its
        // SID points into `buf`, which outlives every read below.
        unsafe {
            let label = &*buf.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
            let sid = label.Label.Sid;
            if !IsValidSid(sid).as_bool() {
                return None;
            }
            let count = GetSidSubAuthorityCount(sid).as_ref().copied()?;
            let last = u32::from(count.checked_sub(1)?);
            GetSidSubAuthority(sid, last).as_ref().copied()
        }
    }

    fn process_integrity_level(process: HANDLE) -> Option<u32> {
        let mut token = HANDLE::default();
        // SAFETY: `token` receives a new handle that is closed below.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        let level = token_integrity_level(token);
        // SAFETY: `token` was opened above and is closed exactly once.
        let _ = unsafe { CloseHandle(token) };
        level
    }

    fn image_name(process: HANDLE) -> Option<String> {
        let mut buf = vec![0u16; IMAGE_NAME_CHARS];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` has `len` writable units and outlives the call.
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        }
        .ok()?;
        let path = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
        Some(file_name(&path).to_string())
    }

    /// Name and integrity level of another process; both None when it cannot be opened.
    fn inspect_process(pid: u32) -> (Option<String>, Option<u32>) {
        // SAFETY: plain OpenProcess; the handle is closed below on every path.
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return (None, None);
        };
        let found = (image_name(process), process_integrity_level(process));
        // SAFETY: `process` was opened above and is closed exactly once.
        let _ = unsafe { CloseHandle(process) };
        found
    }

    fn modifiers_held() -> bool {
        MODIFIERS.iter().any(|vk| {
            // SAFETY: GetAsyncKeyState only reads key state; the high bit means "down now".
            let state = unsafe { GetAsyncKeyState(i32::from(vk.0)) };
            state < 0
        })
    }

    pub fn foreground_target() -> Option<ForegroundTarget> {
        // SAFETY: no arguments; a null handle means no foreground window.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        // SAFETY: `hwnd` came from the OS; `pid` is a live out pointer.
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if thread == 0 {
            // The window was destroyed between the two calls.
            return None;
        }
        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: `gui` is a live struct with `cbSize` set, as the API requires.
        let gui_ok = unsafe { GetGUIThreadInfo(thread, &mut gui) }.is_ok();
        let focus_handle =
            (gui_ok && !gui.hwndFocus.is_invalid()).then_some(gui.hwndFocus.0 as isize as i64);
        let menu_mask = GUI_INMENUMODE.0 | GUI_POPUPMENUMODE.0 | GUI_SYSTEMMENUMODE.0;
        let menu_open = gui_ok && gui.flags.0 & menu_mask != 0;

        let (process_name, target_level) = inspect_process(pid);
        // SAFETY: the pseudo handle of the current process needs no closing.
        let own_level = process_integrity_level(unsafe { GetCurrentProcess() });

        Some(ForegroundTarget {
            window_handle: hwnd.0 as isize as i64,
            focus_handle,
            process_id: pid,
            process_name,
            is_own_process: pid == std::process::id(),
            menu_open,
            modifiers_held: modifiers_held(),
            blocked: is_blocked(own_level, target_level),
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{ForegroundTarget, TypeTextResult};
    use napi::bindgen_prelude::*;

    pub fn type_text(_text: &str) -> Result<TypeTextResult> {
        Err(Error::from_reason(
            "typing into other apps is only available on Windows",
        ))
    }

    pub fn foreground_target() -> Option<ForegroundTarget> {
        None
    }
}

/// The window that would receive typed keys, or null when no window is in the foreground.
#[napi]
pub fn foreground_target() -> Option<ForegroundTarget> {
    imp::foreground_target()
}

/// Types `text` into the focused field with one `SendInput` call. Control characters become
/// spaces. `sent` lower than `expected` means the OS cut the line off.
#[napi]
pub fn type_text(text: String) -> Result<TypeTextResult> {
    imp::type_text(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down(unit: u16) -> UnicodeKey {
        UnicodeKey {
            unit,
            key_up: false,
        }
    }

    fn up(unit: u16) -> UnicodeKey {
        UnicodeKey { unit, key_up: true }
    }

    fn pressed_units(text: &str) -> Vec<u16> {
        encode_keys(text)
            .iter()
            .filter(|k| !k.key_up)
            .map(|k| k.unit)
            .collect()
    }

    #[test]
    fn encode_keys_should_return_nothing_for_empty_text() {
        assert!(encode_keys("").is_empty());
    }

    #[test]
    fn encode_keys_should_press_and_release_each_bmp_unit() {
        assert_eq!(
            encode_keys("hé"),
            vec![down(0x68), up(0x68), down(0xE9), up(0xE9)]
        );
    }

    #[test]
    fn encode_keys_should_type_enye_and_accents_as_single_units() {
        assert_eq!(pressed_units("ñÁü"), vec![0xF1, 0xC1, 0xFC]);
    }

    #[test]
    fn encode_keys_should_send_both_surrogates_down_before_either_up() {
        // U+1F600 is the surrogate pair D83D DE00.
        assert_eq!(
            encode_keys("\u{1F600}"),
            vec![down(0xD83D), down(0xDE00), up(0xD83D), up(0xDE00)]
        );
    }

    #[test]
    fn encode_keys_should_type_control_characters_as_spaces() {
        assert_eq!(
            pressed_units("a\r\n\tb\u{7F}\u{1}"),
            vec![0x61, 0x20, 0x20, 0x20, 0x62, 0x20, 0x20]
        );
    }

    #[test]
    fn encode_keys_should_type_unicode_line_breaks_as_spaces() {
        assert_eq!(
            pressed_units("\u{85}\u{2028}\u{2029}"),
            vec![0x20, 0x20, 0x20]
        );
    }

    #[test]
    fn encode_keys_should_emit_two_events_per_utf16_unit() {
        let text = "año 😀 ok";
        assert_eq!(encode_keys(text).len(), text.encode_utf16().count() * 2);
    }

    #[test]
    fn is_blocked_should_allow_same_or_lower_integrity() {
        assert!(!is_blocked(Some(0x2000), Some(0x2000)));
        assert!(!is_blocked(Some(0x3000), Some(0x2000)));
    }

    #[test]
    fn is_blocked_should_refuse_higher_integrity() {
        assert!(is_blocked(Some(0x2000), Some(0x3000)));
    }

    #[test]
    fn is_blocked_should_refuse_when_a_level_is_unknown() {
        assert!(is_blocked(Some(0x2000), None));
        assert!(is_blocked(None, Some(0x2000)));
    }

    #[test]
    fn file_name_should_keep_the_extension() {
        assert_eq!(file_name(r"C:\Windows\System32\notepad.exe"), "notepad.exe");
        assert_eq!(file_name("C:/x/chrome.exe"), "chrome.exe");
        assert_eq!(file_name("tool"), "tool");
    }
}
