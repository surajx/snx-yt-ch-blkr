// Run with: node --test
// Fixtures mirror the shapes YouTube's web client returned in November 2026.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/inject.js');
const sync = require('../src/sync.js');

const ALLOWED = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const isAllowed = (id) => id === ALLOWED;

const avatar = (channelId) => ({
  decoratedAvatarViewModel: {
    rendererContext: { commandContext: { onTap: { innertubeCommand: { browseEndpoint: { browseId: channelId } } } } },
  },
});
const lockup = (videoId, channelId) => ({
  lockupViewModel: {
    contentId: videoId,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { title: { content: videoId }, ...(channelId ? { image: avatar(channelId) } : {}) } },
  },
});
const short = (videoId) => ({
  shortsLockupViewModel: { entityId: `shorts-shelf-item-${videoId}`, onTap: { innertubeCommand: { reelWatchEndpoint: { videoId } } } },
});
const continuation = () => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next' } } } });
const env = (extra = {}) => ({ isAllowed, endpoint: 'next', requestBrowseId: '', pathname: '/watch', lastChannel: null, ...extra });

test('sidebar keeps subscribed channels and drops the rest, including the Shorts shelf', () => {
  const data = {
    contents: {
      twoColumnWatchNextResults: {
        secondaryResults: {
          secondaryResults: {
            results: [
              {
                itemSectionRenderer: {
                  contents: [
                    lockup('v1', OTHER),
                    { reelShelfRenderer: { title: 'Shorts', items: [short('s1'), short('s2')] } },
                    lockup('v2', ALLOWED),
                    lockup('v3', OTHER),
                    continuation(),
                  ],
                },
              },
            ],
          },
        },
        autoplay: { autoplay: { sets: [{ mode: 'NORMAL', autoplayVideo: { watchEndpoint: { videoId: 'v1' } } }] } },
      },
    },
    playerOverlays: {
      playerOverlayRenderer: {
        shareButton: {},
        autoplay: { playerOverlayAutoplayRenderer: { videoId: 'v1', byline: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: OTHER } } }] } } },
        endScreen: {
          watchNextEndScreenRenderer: {
            results: [
              { endScreenVideoRenderer: { videoId: 'v1', shortBylineText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: OTHER } } }] } } },
              { endScreenVideoRenderer: { videoId: 'v2', shortBylineText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: ALLOWED } } }] } } },
              { endScreenVideoRenderer: { videoId: 'mix' } },
            ],
          },
        },
      },
    },
  };
  const { removed } = core.pruneResponse(data, env());
  assert.ok(removed > 0);
  const items = data.contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results[0].itemSectionRenderer.contents;
  assert.deepEqual(items.map((x) => Object.keys(x)[0]), ['lockupViewModel', 'continuationItemRenderer']);
  assert.equal(items[0].lockupViewModel.contentId, 'v2');
  // Autoplay pointed at a removed video, so it is cancelled; the rest of the overlay survives.
  assert.equal(data.contents.twoColumnWatchNextResults.autoplay.autoplay.sets[0].autoplayVideo, undefined);
  assert.equal(data.playerOverlays.playerOverlayRenderer.autoplay, undefined);
  assert.ok(data.playerOverlays.playerOverlayRenderer.shareButton);
  const end = data.playerOverlays.playerOverlayRenderer.endScreen.watchNextEndScreenRenderer.results;
  assert.deepEqual(end.map((x) => x.endScreenVideoRenderer.videoId), ['v2']);
});

test('search keeps channel results and removes emptied shelves', () => {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { officialCardViewModel: { header: { browseEndpoint: { browseId: OTHER } } } },
                    { channelRenderer: { channelId: OTHER } },
                    { gridShelfViewModel: { contents: [short('s1'), short('s2')] } },
                    lockup('v1', OTHER),
                    lockup('v2', ALLOWED),
                  ],
                },
              },
              continuation(),
            ],
          },
        },
      },
    },
  };
  core.pruneResponse(data, env({ endpoint: 'search', pathname: '/results' }));
  const items = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
  assert.deepEqual(items.map((x) => Object.keys(x)[0]), ['officialCardViewModel', 'channelRenderer', 'lockupViewModel']);
});

test('a "load more" page that keeps nothing also loses its continuation', () => {
  const page = {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: [lockup('v1', OTHER), lockup('v2', OTHER), continuation()] } },
    ],
  };
  core.pruneResponse(page, env());
  assert.deepEqual(page.onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems, []);

  const mixed = {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: [lockup('v1', OTHER), lockup('v2', ALLOWED), continuation()] } },
    ],
  };
  core.pruneResponse(mixed, env());
  assert.equal(mixed.onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems.length, 2);
});

test('channel pages: videos without their own channel inherit the page channel', () => {
  const page = (channelId) => ({
    responseContext: { serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'browse_id', value: channelId }] }] },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                richGridRenderer: {
                  contents: [{ richItemRenderer: { content: lockup('v1'), trackingParams: 'x' } }, { richItemRenderer: { content: lockup('v2') } }],
                },
              },
            },
          },
        ],
      },
    },
  });
  const grid = (d) => d.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;

  const subscribed = page(ALLOWED);
  assert.equal(core.pruneResponse(subscribed, env({ endpoint: 'browse', pathname: '/@a/videos' })).removed, 0);
  assert.equal(grid(subscribed).length, 2);

  const stranger = page(OTHER);
  const result = core.pruneResponse(stranger, env({ endpoint: 'browse', pathname: '/@b/videos' }));
  assert.equal(result.removed, 2);
  assert.equal(result.channel, OTHER);
  assert.equal(grid(stranger).length, 0);
  assert.equal(stranger.contents.twoColumnBrowseResultsRenderer.tabs.length, 1, 'the tab itself must survive');
});

test('the subscriptions feed is never pruned', () => {
  const data = {
    responseContext: { serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'browse_id', value: 'FEsubscriptions' }] }] },
    contents: { richGridRenderer: { contents: [{ richItemRenderer: { content: lockup('v1', OTHER) } }, { richItemRenderer: { content: short('s1') } }] } },
  };
  assert.equal(core.pruneResponse(data, env({ endpoint: 'browse', pathname: '/feed/subscriptions' })).removed, 0);
  assert.equal(data.contents.richGridRenderer.contents.length, 2);
});

test('player responses are found inside get_watch and made unplayable', () => {
  const reply = [
    { responseContext: {}, playerResponse: { playabilityStatus: { status: 'OK' }, streamingData: { formats: [1] }, videoDetails: { videoId: 'v1', channelId: OTHER } } },
    { responseContext: {}, watchNextResponse: { contents: {} } },
  ];
  const found = core.findPlayerResponses(reply);
  assert.equal(found.length, 1);
  core.blockPlayerResponse(found[0], 'Blocked', 'Not subscribed');
  assert.equal(reply[0].playerResponse.playabilityStatus.status, 'UNPLAYABLE');
  assert.equal(reply[0].playerResponse.streamingData, undefined);
  assert.equal(reply[0].playerResponse.videoDetails.channelId, OTHER);
});

test('guide subscriptions are collected, including the collapsed ones', () => {
  const entry = (id, title) => ({
    guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: '/@' + title } }, formattedTitle: { simpleText: title } },
  });
  const guide = {
    items: [
      { guideSectionRenderer: { items: [entry('FEwhat_to_watch', 'Home'), entry(OTHER.replace('b', 'c'), 'NotASub')] } },
      {
        guideSubscriptionsSectionRenderer: {
          items: [entry(ALLOWED, 'Alpha'), { guideCollapsibleEntryRenderer: { expandableItems: [entry(OTHER, 'Beta'), entry('FEchannels', 'All')] } }],
        },
      },
    ],
  };
  assert.deepEqual(core.collectGuideSubscriptions(guide), [
    { id: ALLOWED, title: 'Alpha', handle: '@Alpha' },
    { id: OTHER, title: 'Beta', handle: '@Beta' },
  ]);
});

test('only API calls that can carry videos are inspected', () => {
  assert.equal(core.shouldInspect('https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false'), true);
  assert.equal(core.shouldInspect('/youtubei/v1/player'), true);
  assert.equal(core.shouldInspect('/youtubei/v1/log_event?alt=json'), false);
  assert.equal(core.shouldInspect('https://i.ytimg.com/vi/x/hq.jpg'), false);
  assert.equal(core.endpointOf('/youtubei/v1/subscription/subscribe?x=1'), 'subscription/subscribe');
});

test('subscription page parsing', () => {
  const html = 'x var ytInitialData = {"a":"}{\\"","contents":{"items":[{"channelRenderer":{"channelId":"' + ALLOWED +
    '","title":{"simpleText":"Alpha"},"navigationEndpoint":{"browseEndpoint":{"canonicalBaseUrl":"/@alpha"}}}},' +
    '{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"T"}}}}]}};</script>';
  const data = sync.extractJsonAfter(html, 'var ytInitialData =');
  assert.deepEqual([...sync.collectChannels(data)], [[ALLOWED, { title: 'Alpha', handle: '@alpha' }]]);
  assert.equal(sync.findContinuationToken(data), 'T');
});
