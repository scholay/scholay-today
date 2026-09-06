use papr_core::{
    db,
    library::{self, Mutation::*},
};

#[test]
fn complete_subscription_and_folder_lifecycle() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let xml = br#"<rss version="2.0"><channel><title>Fixture</title><link>https://example.org</link><description>Test</description><item><guid>one</guid><title>Retained article</title><link>https://example.org/one</link></item></channel></rss>"#;
    let feed = library::subscribe(&c, "https://example.org/feed", xml, None, None, "test").unwrap();
    let duplicate =
        library::subscribe(&c, "https://example.org/feed", xml, None, None, "test").unwrap();
    assert_eq!(feed.id, duplicate.id);
    let apply = |actions: Vec<papr_core::library::Mutation>| {
        library::apply(
            &c,
            &actions,
            "test",
            false,
            Some(library::revision(&c).unwrap()),
            None,
        )
        .unwrap()
    };
    let parent = apply(vec![CreateFolder {
        name: "Parent".into(),
        parent_id: None,
    }])["results"][0]["id"]
        .as_i64()
        .unwrap();
    let child = apply(vec![CreateFolder {
        name: "Child".into(),
        parent_id: Some(parent),
    }])["results"][0]["id"]
        .as_i64()
        .unwrap();
    apply(vec![
        RenameFolder {
            id: child,
            name: "Research".into(),
        },
        MoveFolder {
            id: child,
            parent_id: None,
            position: Some(4),
        },
        MoveFolder {
            id: child,
            parent_id: Some(parent),
            position: None,
        },
    ]);
    apply(vec![
        RenameFeed {
            id: feed.id,
            title: "Renamed".into(),
        },
        MoveFeed {
            id: feed.id,
            folder_id: Some(parent),
        },
        SetFeedUrl {
            id: feed.id,
            url: "https://example.org/new-feed".into(),
        },
        SetFeedInterval {
            id: feed.id,
            minutes: Some(60),
        },
    ]);
    let changed = db::list_feeds(&c).unwrap();
    assert_eq!(changed[0].title, "Renamed");
    assert_eq!(changed[0].feed_url, "https://example.org/new-feed");
    apply(vec![DeleteFolder { id: parent }]);
    assert!(db::list_feeds(&c).unwrap()[0].folder_id.is_none());
    assert!(library::folders(&c).unwrap()[0]["parentId"].is_null());
    apply(vec![ArchiveFeed { id: feed.id }]);
    assert!(db::feeds_for_export(&c).unwrap().is_empty());
    assert!(db::feed_urls_for_sync(&c).unwrap().is_empty());
    assert!(db::feeds_to_refresh(&c).unwrap().is_empty());
    assert_eq!(
        c.query_row("SELECT count(*) FROM articles", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    apply(vec![RestoreFeed { id: feed.id }]);
    assert_eq!(db::list_feeds(&c).unwrap().len(), 1);
    assert_eq!(db::feeds_for_export(&c).unwrap().len(), 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}
