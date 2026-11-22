//! Ranking checked against the real tool lists of the catalog's providers. The fixture's `source`
//! field says where its text came from and when.

use gator_core::Index;
use serde_json::Value;
use std::sync::LazyLock;

static INDEX: LazyLock<Index> =
    LazyLock::new(|| Index::new(include_str!("fixtures/tools.json")).unwrap());

fn search(query: &str, provider: Option<&str>, limit: usize) -> Vec<String> {
    let result: Value = serde_json::from_str(&INDEX.search(query, provider, limit)).unwrap();
    let tools = result["tools"].as_array().unwrap().iter();
    tools
        .map(|tool| tool["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_fixture_is_the_size_the_test_assumes() {
    let result: Value = serde_json::from_str(&INDEX.search("", None, 5)).unwrap();
    assert_eq!(result["total"], 191);
    assert_eq!(result["providers"].as_array().unwrap().len(), 8);
}

#[test]
fn sensible_queries_rank_the_expected_tool_in_the_top_three() {
    let cases: &[(&str, &[&str])] = &[
        (
            "reddit posts about mechanical keyboards",
            &["redlisten.search_reddit"],
        ),
        ("search reddit", &["redlisten.search_reddit"]),
        (
            "what are people on reddit saying",
            &["redlisten.search_reddit"],
        ),
        ("newest posts in a subreddit", &["redlisten.latest_posts"]),
        ("reddit thread comments", &["redlisten.get_thread"]),
        ("posts by a reddit user", &["redlisten.user_history"]),
        (
            "how often is a keyword mentioned on reddit",
            &["redlisten.keyword_trends", "redlisten.reddit_preview"],
        ),
        (
            "amazon product reviews",
            &[
                "zoodata.openapi_v2_reviews_search",
                "zoodata.openapi_v2_realtime_reviews",
            ],
        ),
        (
            "search amazon products",
            &["zoodata.openapi_v2_products_search"],
        ),
        (
            "amazon price history",
            &["zoodata.openapi_v2_products_history"],
        ),
        (
            "amazon best sellers in a category",
            &["zoodata.openapi_v2_realtime_bestsellers"],
        ),
        (
            "current price of an amazon product by ASIN",
            &["zoodata.openapi_v3_realtime_product"],
        ),
        (
            "tiktok shop products",
            &["zoodata.openapi_v2_tiktok_products_search"],
        ),
        (
            "youtube video transcript",
            &["transcriptapi.get_youtube_transcript"],
        ),
        ("transcript", &["transcriptapi.get_youtube_transcript"]),
        (
            "get the transcript of a youtube video",
            &["transcriptapi.get_youtube_transcript"],
        ),
        ("list open issues in a repository", &["github.list_issues"]),
        (
            "open issues mentioning a word",
            &["github.search_issues", "github.list_issues"],
        ),
        ("search youtube videos", &["transcriptapi.search_youtube"]),
        (
            "latest videos from a youtube channel",
            &["transcriptapi.get_channel_latest_videos"],
        ),
        (
            "videos in a playlist",
            &["transcriptapi.list_playlist_videos"],
        ),
        (
            "latest release of a github repository",
            &["github.get_latest_release"],
        ),
        ("list issues in a repo", &["github.list_issues"]),
        ("search code on github", &["github.search_code"]),
        ("pull request details", &["github.pull_request_read"]),
        (
            "read a file from a github repository",
            &["github.get_file_contents"],
        ),
        ("find github repositories", &["github.search_repositories"]),
        ("recent commits on a branch", &["github.list_commits"]),
        (
            "web search for recent news",
            &["tavily.tavily_search", "firecrawl.firecrawl_search"],
        ),
        (
            "search the web",
            &["tavily.tavily_search", "firecrawl.firecrawl_search"],
        ),
        ("scrape a web page", &["firecrawl.firecrawl_scrape"]),
        (
            "read the text of a web page",
            &["firecrawl.firecrawl_scrape", "tavily.tavily_extract"],
        ),
        (
            "extract text from web pages",
            &["tavily.tavily_extract", "firecrawl.firecrawl_scrape"],
        ),
        ("stock quote for AAPL", &["fmp.quote"]),
        ("apple stock price history", &["fmp.chart"]),
        (
            "company income statement and balance sheet",
            &["fmp.statements"],
        ),
        ("analyst price targets", &["fmp.analyst"]),
        ("next earnings date", &["fmp.calendar"]),
        ("insider trades", &["fmp.insiderTrades"]),
        ("SEC filings for a company", &["fmp.secFilings"]),
        ("search posts on X", &["x.search_posts_all"]),
        ("search tweets", &["x.search_posts_all"]),
        ("twitter posts about a topic", &["x.search_posts_all"]),
        ("recent posts by a user on X", &["x.get_users_posts"]),
        ("X user profile by username", &["x.get_users_by_username"]),
        (
            "read a post on X by its id",
            &["x.get_posts_by_id", "x.get_posts_by_ids"],
        ),
    ];
    let spoken: &[(&str, &[&str])] = &[
        (
            "what changed in the latest release of this repo",
            &["github.get_latest_release"],
        ),
        (
            "pull the transcript of this YouTube video",
            &["transcriptapi.get_youtube_transcript"],
        ),
        (
            "find reviews for this Amazon product",
            &["zoodata.openapi_v2_reviews_search"],
        ),
        (
            "what are people saying about the new iphone on reddit",
            &["redlisten.search_reddit"],
        ),
        ("news about the election", &["tavily.tavily_search"]),
        (
            "how many subscribers does this youtube channel have",
            &["transcriptapi.get_channel_info"],
        ),
    ];
    let mut failures = Vec::new();
    for (query, expected) in cases.iter().chain(spoken) {
        let top = search(query, None, 3);
        if !top.iter().any(|id| expected.contains(&id.as_str())) {
            failures.push(format!(
                "{query:?} ranked {top:?}, expected one of {expected:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn an_exact_id_or_name_comes_first() {
    assert_eq!(search("get_thread", None, 1), ["redlisten.get_thread"]);
    assert_eq!(
        search("github.search_code", None, 1),
        ["github.search_code"]
    );
    assert_eq!(
        search("  tavily_extract ", None, 1),
        ["tavily.tavily_extract"]
    );
}

#[test]
fn the_provider_filter_keeps_only_that_provider() {
    let hits = search("search", Some("github"), 20);
    assert!(hits.len() > 3);
    assert!(hits.iter().all(|id| id.starts_with("github.")));
    assert!(search("search", Some("nope"), 20).is_empty());
    // A request in words no tool of the provider has still lists that provider's tools.
    assert_eq!(
        search("what did this account say lately", Some("x"), 5).len(),
        4
    );
}

#[test]
fn the_limit_is_clamped() {
    assert_eq!(search("search", None, 0).len(), 1);
    assert_eq!(search("search", None, 7).len(), 7);
    assert_eq!(search("search", None, 1000).len(), 20);
}

#[test]
fn matching_ignores_case_plurals_and_naming_style() {
    assert_eq!(
        search("TRANSCRIPTS", None, 1),
        search("transcript", None, 1)
    );
    assert_eq!(
        search("repository", None, 3),
        search("repositories", None, 3)
    );
    assert_eq!(search("getThread", None, 1), ["redlisten.get_thread"]);
    // A camelCase brand is found however it is typed.
    assert_eq!(
        search("YouTube transcript", None, 3),
        search("youtube transcript", None, 3)
    );
    assert_eq!(
        search("GitHub releases", None, 3),
        search("github releases", None, 3)
    );
    assert_eq!(
        search("tube", None, 1)[0].split('.').next(),
        Some("transcriptapi")
    );
    assert_eq!(search("latest-posts", None, 1), ["redlisten.latest_posts"]);
}

#[test]
fn queries_in_any_script_are_answered() {
    for query in [
        "苹果股价",
        "précio del café ☕",
        "видео на YouTube",
        "🐊",
        "a\u{0}b\u{ffff}",
        "ǅ ß İ",
        &"x ".repeat(5000),
    ] {
        let result: Value = serde_json::from_str(&INDEX.search(query, None, 5)).unwrap();
        assert!(result["tools"].is_array(), "{query:?}");
    }
    assert_eq!(
        search("видео на YouTube", None, 1)[0].split('.').next(),
        Some("transcriptapi")
    );
}
