-- Two adjustments to the seeded website registry from 0022/0014.
--
-- 1. Trim the default NSFW set. 0022 seeded a dozen adult sites; the default
--    template only needs the few most-submitted ones. Keep pornhub, xvideos and
--    rule34 (seeded as `rule34video`, the video host yt-dlp actually extracts);
--    drop the rest. DELETE, not an edit of 0022 — applied migrations are
--    checksum-verified by sqlx, so removing rows has to be its own step, which
--    also cleans up installs that already ran 0022. Items keep their history;
--    only the registry entry (host detection + blur default) goes away.
DELETE FROM websites WHERE key IN (
  'xhamster', 'xnxx', 'redtube', 'youporn', 'spankbang',
  'redgifs', 'eporner', 'motherless', 'beeg'
);

-- 2. Mainstream video platforms that were missing from the seed. Each ships a
--    yt-dlp extractor and carries its known alternate domains / short-link and
--    mobile subdomains so a pasted link is recognised (clipboard grabber,
--    per-site cookies, download-folder folding). Tracking-param stripping is
--    handled generically for every host by src/url_normalize.rs (the global
--    TRACKING list); the pure-tracking-query hosts (douyin, xiaohongshu) are
--    listed there explicitly. INSERT OR IGNORE so a key an operator already
--    added by hand is left untouched. Sort continues after the classic block.
INSERT OR IGNORE INTO websites (key, name, hosts, login_url, enabled, sort) VALUES
  ('rumble',      'Rumble',        'rumble.com',                              '',                                        1, 26),
  ('kick',        'Kick',          'kick.com',                                '',                                        1, 27),
  ('vk',          'VK',            'vk.com,vkvideo.ru,vk.ru,vk.cc,vkontakte.ru', 'https://vk.com/login',                 1, 28),
  ('odysee',      'Odysee',        'odysee.com',                              'https://odysee.com/$/signin',             1, 29),
  ('streamable',  'Streamable',    'streamable.com',                          '',                                        1, 30),
  ('bitchute',    'BitChute',      'bitchute.com',                            '',                                        1, 31),
  ('pinterest',   'Pinterest',     'pinterest.com,pin.it',                    'https://www.pinterest.com/login/',        1, 32),
  ('tumblr',      'Tumblr',        'tumblr.com',                              'https://www.tumblr.com/login',            1, 33),
  ('bluesky',     'Bluesky',       'bsky.app',                                'https://bsky.app/',                       1, 34),
  ('threads',     'Threads',       'threads.net,threads.com',                 'https://www.threads.net/login',           1, 35),
  ('douyin',      'Douyin',        'douyin.com,iesdouyin.com',                '',                                        1, 36),
  ('xiaohongshu', 'Xiaohongshu',   'xiaohongshu.com,xhslink.com',             '',                                        1, 37),
  ('youku',       'Youku',         'youku.com',                               'https://passport.youku.com/',             1, 38),
  ('tencent',     'Tencent Video', 'v.qq.com',                                'https://v.qq.com/',                       1, 39);
