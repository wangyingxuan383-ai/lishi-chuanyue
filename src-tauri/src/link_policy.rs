use serde::Deserialize;

#[derive(Deserialize)]
struct Rule {
    origin: String,
    path: String,
    #[serde(default)]
    children: bool,
}

/// Release packages for the in-app update: assets of this repository's
/// releases, and the hosts GitHub redirects those downloads to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    prefix: String,
    redirect_hosts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    browser: Vec<Rule>,
    public_get: Vec<String>,
    download: Download,
}

fn policy() -> Policy {
    serde_json::from_str(include_str!("../../src/platform/link-policy.json"))
        .expect("bundled link policy")
}

/// An https URL without credentials, an explicit port or shell-significant characters.
fn plain_https(raw: &str) -> Option<reqwest::Url> {
    if raw
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\')
    {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then_some(url)
}

/// A release asset of this repository (any hop), or one of the hosts GitHub
/// redirects that download to (`redirect` hops only, never a starting URL).
pub fn download_allowed(raw: &str, redirect: bool) -> bool {
    let Some(url) = plain_https(raw) else {
        return false;
    };
    let download = policy().download;
    // The parsed form: "." and ".." segments are already resolved here.
    if let Some(rest) = url.as_str().strip_prefix(&download.prefix) {
        // Exactly <tag>/<file name>; no query or fragment is ever needed.
        return url.query().is_none()
            && url.fragment().is_none()
            && rest.split_once('/').is_some_and(|(tag, name)| {
                !tag.is_empty() && !name.is_empty() && !name.contains('/')
            });
    }
    redirect
        && url
            .host_str()
            .is_some_and(|host| download.redirect_hosts.iter().any(|h| h == host))
}

pub fn allowed(raw: &str, public_get: bool) -> bool {
    let Some(url) = plain_https(raw) else {
        return false;
    };
    let policy = policy();
    if public_get {
        policy.public_get.iter().any(|allowed| allowed == raw)
    } else {
        policy.browser.iter().any(|rule| {
            url.origin().ascii_serialization() == rule.origin
                && (url.path() == rule.path
                    || (rule.children && url.path().starts_with(&format!("{}/", rule.path))))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_bundled_links_work() {
        let policy: Policy =
            serde_json::from_str(include_str!("../../src/platform/link-policy.json")).unwrap();
        for rule in policy.browser {
            assert!(allowed(&format!("{}{}", rule.origin, rule.path), false));
        }
        for url in policy.public_get {
            assert!(allowed(&url, true));
        }
        assert!(allowed(
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v0.9.0",
            false
        ));
    }
    #[test]
    fn blocks_other_hosts_paths_credentials_and_shell_characters() {
        for raw in [
            "http://github.com/wangyingxuan383-ai/lishi-chuanyue",
            "https://github.com.evil.test/wangyingxuan383-ai/lishi-chuanyue",
            "https://user:pass@github.com/wangyingxuan383-ai/lishi-chuanyue",
            "https://github.com:444/wangyingxuan383-ai/lishi-chuanyue",
            "https://github.com/other/repo",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue-evil",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue\n",
            "https://github.com\\@evil.test/wangyingxuan383-ai/lishi-chuanyue",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue\"",
            "https://api.github.com/repos/other/repo/releases?per_page=5",
        ] {
            assert!(!allowed(raw, false), "{raw}");
            assert!(!allowed(raw, true), "{raw}");
        }
        assert!(!allowed("https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5&x=1", true));
    }
    #[test]
    fn downloads_only_this_repositorys_release_assets_and_github_asset_hosts() {
        let asset = "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v0.10.1/chuanyue-0.10.1.apk";
        assert!(download_allowed(asset, false));
        assert!(download_allowed(asset, true));
        let signed = "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=x";
        assert!(download_allowed(signed, true));
        assert!(download_allowed(
            "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?X-Amz-Signature=x",
            true
        ));
        // Asset hosts are only reachable as GitHub's redirect, never as a starting URL.
        assert!(!download_allowed(signed, false));
        for raw in [
            "http://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v0.10.1/a.apk",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v0.10.1",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue-evil/releases/download/v1/a.apk",
            "https://github.com/other/repo/releases/download/v1/a.apk",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk?x=1",
            "https://github.com:444/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk",
            "https://user@github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk",
            "https://release-assets.githubusercontent.com.evil.test/a",
            "https://evil.test/github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk",
            "https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5",
            "http://127.0.0.1:18990/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/../../../other/repo",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/%2e%2e/%2e%2e/x/y",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/",
            "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a/b.apk",
        ] {
            assert!(!download_allowed(raw, true), "{raw}");
            assert!(!download_allowed(raw, false), "{raw}");
        }
    }
}
