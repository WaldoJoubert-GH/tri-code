//! Saved passwords for Browser Profiles on macOS, where WKWebView has no password AutoFill of its
//! own (WebView2 on Windows saves and fills them itself; see browser.rs). passwords.js runs in a
//! WKContentWorld of its own, which page scripts can't see or post from: it reports sign-ins and
//! fills saved logins. Passwords stay in this process and the macOS Keychain (one item per
//! profile) and never reach tri-code's HTML, which only learns the site and the username.

use serde::Serialize;

/// A saved login as Settings › Browser lists it: no password.
#[derive(Clone, Serialize)]
pub struct SavedLogin {
    origin: String,
    user: String,
}

/// Answer the save prompt of a webview's last sign-in: save (or update) it, or drop it.
#[tauri::command]
pub async fn browser_password_answer(label: String, save: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::answer(&label, save)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (label, save);
        Ok(())
    }
}

/// A profile's saved logins (macOS; WebView2 keeps its own out of reach).
#[tauri::command]
pub async fn browser_passwords(profile: String) -> Result<Vec<SavedLogin>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::list(&profile)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn browser_password_forget(profile: String, origin: String, user: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::forget(&profile, &origin, &user)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (profile, origin, user);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{erase, install, page_loaded, set_enabled, unwatch};

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{NSObjectProtocol, NSString};
    use objc2_web_kit::{WKContentWorld, WKScriptMessage, WKScriptMessageHandler, WKSecurityOrigin, WKUserContentController, WKWebView};
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter, Url, Webview};

    use super::SavedLogin;

    /// The Keychain items' service; the account is the profile id.
    const SERVICE: &str = "tri-code browser passwords";
    const WORLD: &str = "tricode-passwords";
    const HANDLER: &str = "tricodePasswords";
    const SCRIPT: &str = include_str!("passwords.js");
    /// errSecItemNotFound: a profile that hasn't saved anything yet.
    const NOT_FOUND: i32 = -25300;

    #[derive(Clone, PartialEq, Serialize, Deserialize)]
    struct Login {
        user: String,
        pass: String,
    }

    /// One profile's logins, by origin (`https://github.com`).
    type Vault = BTreeMap<String, Vec<Login>>;

    struct Pending {
        profile: String,
        origin: String,
        login: Login,
    }

    #[derive(Default)]
    struct State {
        /// Per webview label: its profile, and whether that profile saves passwords.
        views: HashMap<String, (String, bool)>,
        /// Per webview label: the sign-in its save prompt is asking about.
        pending: HashMap<String, Pending>,
        /// Vaults read from the Keychain so far.
        vaults: HashMap<String, Vault>,
    }

    fn state() -> MutexGuard<'static, State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A profile's vault. A Keychain error other than "none yet" fails rather than starting empty,
    /// which a save would then write over the real one with.
    fn vault<'a>(st: &'a mut State, profile: &str) -> Result<&'a mut Vault, String> {
        if !st.vaults.contains_key(profile) {
            let v = match get_generic_password(SERVICE, profile) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                Err(e) if e.code() == NOT_FOUND => Vault::new(),
                Err(e) => return Err(format!("couldn't read saved passwords: {e}")),
            };
            st.vaults.insert(profile.to_string(), v);
        }
        Ok(st.vaults.get_mut(profile).expect("just inserted"))
    }

    fn write(profile: &str, v: &Vault) -> Result<(), String> {
        if v.is_empty() {
            return match delete_generic_password(SERVICE, profile) {
                Err(e) if e.code() != NOT_FOUND => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let json = serde_json::to_vec(v).map_err(|e| e.to_string())?;
        set_generic_password(SERVICE, profile, &json).map_err(|e| format!("couldn't save the password: {e}"))
    }

    /// The origin logins are kept under: https sites, and http only on this machine.
    fn web_origin(url: &str) -> Option<String> {
        let u = Url::parse(url).ok()?;
        let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        (u.scheme() == "https" || (u.scheme() == "http" && local)).then(|| u.origin().ascii_serialization())
    }

    fn origin_of(o: &WKSecurityOrigin) -> Option<String> {
        // SAFETY: plain property reads on an object WebKit handed us on the main thread.
        let (proto, host, port) = unsafe { (o.protocol().to_string(), o.host().to_string(), o.port()) };
        web_origin(&if port == 0 { format!("{proto}://{host}") } else { format!("{proto}://{host}:{port}") })
    }

    #[derive(Clone, Serialize)]
    struct Prompt {
        label: String,
        origin: String,
        user: String,
        /// The username is saved already, with another password.
        update: bool,
    }

    #[derive(Deserialize)]
    struct Message {
        user: String,
        pass: String,
    }

    /// passwords.js saw a sign-in: ask the frontend whether to save it, unless it's saved already.
    fn received(app: &AppHandle, label: &str, message: &WKScriptMessage) {
        // SAFETY: WebKit calls the handler on the main thread with a live message.
        let (origin, body) = unsafe {
            let frame = message.frameInfo();
            if !frame.isMainFrame() {
                return;
            }
            let Some(origin) = origin_of(&frame.securityOrigin()) else { return };
            let Ok(body) = message.body().downcast::<NSString>() else { return };
            (origin, body.to_string())
        };
        let Ok(msg) = serde_json::from_str::<Message>(&body) else { return };
        if msg.pass.is_empty() || msg.pass.len() > 4096 || msg.user.len() > 512 {
            return;
        }
        let login = Login { user: msg.user.trim().to_string(), pass: msg.pass };
        let mut st = state();
        let Some((profile, true)) = st.views.get(label).cloned() else { return };
        let Ok(v) = vault(&mut st, &profile) else { return };
        let saved = v.get(&origin).map(Vec::as_slice).unwrap_or_default();
        if saved.contains(&login) {
            return;
        }
        let update = saved.iter().any(|l| l.user == login.user);
        let user = login.user.clone();
        st.pending.insert(label.to_string(), Pending { profile, origin: origin.clone(), login });
        drop(st);
        let _ = app.emit("browser-password", Prompt { label: label.to_string(), origin, user, update });
    }

    struct Ivars {
        app: AppHandle,
        label: String,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and Handler doesn't implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "TriCodePasswordHandler"]
        #[ivars = Ivars]
        struct Handler;

        unsafe impl NSObjectProtocol for Handler {}

        unsafe impl WKScriptMessageHandler for Handler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
                received(&self.ivars().app, &self.ivars().label, message);
            }
        }
    );

    impl Handler {
        fn new(mtm: MainThreadMarker, app: AppHandle, label: String) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { app, label });
            // SAFETY: NSObject's init, on a freshly allocated object.
            unsafe { msg_send![super(this), init] }
        }
    }

    fn world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
        // SAFETY: a class method returning a retained world; same name, same world.
        unsafe { WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm) }
    }

    /// Listen for passwords.js's messages in a new webview. `on` is its profile's switch.
    pub fn install(app: &AppHandle, webview: &Webview, label: &str, profile: &str, on: bool) -> Result<(), String> {
        state().views.insert(label.to_string(), (profile.to_string(), on));
        let (app, label) = (app.clone(), label.to_string());
        webview
            .with_webview(move |pw| {
                let Some(mtm) = MainThreadMarker::new() else { return };
                // SAFETY: inner() is the live WKWebView, and with_webview runs us on the main thread.
                unsafe {
                    let view = &*(pw.inner() as *const WKWebView);
                    let controller = view.configuration().userContentController();
                    let handler = Handler::new(mtm, app, label);
                    controller.addScriptMessageHandler_contentWorld_name(
                        ProtocolObject::from_ref(&*handler),
                        &world(mtm),
                        &NSString::from_str(HANDLER),
                    );
                }
            })
            .map_err(|e| e.to_string())
    }

    /// A profile's Save passwords switch changed for one of its webviews.
    pub fn set_enabled(label: &str, on: bool) {
        let mut st = state();
        if let Some(view) = st.views.get_mut(label) {
            view.1 = on;
        }
        if !on {
            st.pending.remove(label);
        }
    }

    /// A webview closed.
    pub fn unwatch(label: &str) {
        let mut st = state();
        st.views.remove(label);
        st.pending.remove(label);
    }

    /// A page finished loading: start passwords.js in it and give it the site's saved logins.
    pub fn page_loaded(webview: &Webview, label: &str, url: &Url) {
        let Some(origin) = web_origin(url.as_str()) else { return };
        let logins = {
            let mut st = state();
            let Some((profile, true)) = st.views.get(label).cloned() else { return };
            vault(&mut st, &profile).map(|v| v.get(&origin).cloned().unwrap_or_default()).unwrap_or_default()
        };
        let js = format!(
            "{SCRIPT}\nwindow.__tricodeFill({}, {}); undefined",
            serde_json::to_string(&origin).unwrap_or_default(),
            serde_json::to_string(&logins).unwrap_or_default(),
        );
        let _ = webview.with_webview(move |pw| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            // SAFETY: as in install; the script runs in our world, out of the page's reach.
            unsafe {
                let view = &*(pw.inner() as *const WKWebView);
                view.evaluateJavaScript_inFrame_inContentWorld_completionHandler(&NSString::from_str(&js), None, &world(mtm), None);
            }
        });
    }

    pub fn answer(label: &str, save: bool) -> Result<(), String> {
        let mut st = state();
        let Some(Pending { profile, origin, login }) = st.pending.remove(label) else { return Ok(()) };
        if !save {
            return Ok(());
        }
        let v = vault(&mut st, &profile)?;
        let list = v.entry(origin).or_default();
        list.retain(|l| l.user != login.user);
        list.push(login);
        write(&profile, v)
    }

    pub fn list(profile: &str) -> Result<Vec<SavedLogin>, String> {
        let mut st = state();
        let v = vault(&mut st, profile)?;
        Ok(v.iter()
            .flat_map(|(origin, logins)| logins.iter().map(|l| SavedLogin { origin: origin.clone(), user: l.user.clone() }))
            .collect())
    }

    pub fn forget(profile: &str, origin: &str, user: &str) -> Result<(), String> {
        let mut st = state();
        let v = vault(&mut st, profile)?;
        if let Some(list) = v.get_mut(origin) {
            list.retain(|l| l.user != user);
            if list.is_empty() {
                v.remove(origin);
            }
        }
        write(profile, v)
    }

    /// Delete a profile's saved passwords (erasing its data).
    pub fn erase(profile: &str) -> Result<(), String> {
        let mut st = state();
        st.vaults.remove(profile);
        st.pending.retain(|_, p| p.profile != profile);
        write(profile, &Vault::new())
    }
}
