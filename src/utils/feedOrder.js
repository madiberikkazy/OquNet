/**
 * What order a feed comes in.
 *
 * Two screens ask for the same thing and would otherwise each invent it: a list
 * that is not simply newest-first, so the same books and the same notices stop
 * being the ones everybody sees, and the older half of a community's shelf gets
 * looked at.
 *
 * The shuffle is *stable*, and that is the whole design. A `Math.random()`
 * comparator re-orders on every render: rows jump under the reader's thumb, a
 * tap lands on the wrong book, and React throws away DOM it could have kept.
 * Here the position of an item is a pure function of its id and one seed, so it
 * holds still for as long as the seed does — a screen visit — and differs the
 * next time the screen is opened.
 */

/** A seed for one visit to a screen. Keep it in state; do not derive per render. */
export function newFeedSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** FNV-1a over the id and the seed. Cheap, and spread out enough to sort by. */
function hashOf(key, seed) {
  let h = (2166136261 ^ seed) >>> 0;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * The same items, in an order that depends only on their ids and the seed.
 *
 * Ties break on the key itself, so two items that happen to hash alike still
 * have one settled order rather than whatever the sort was feeling.
 */
export function shuffleStable(items, seed, keyOf = (item) => item?.id ?? "") {
  return [...(items || [])].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return hashOf(ka, seed) - hashOf(kb, seed) || String(ka).localeCompare(String(kb));
  });
}

/**
 * A feed: the people you follow first, everybody else after, each half shuffled.
 *
 * Following somebody is a statement that you want to read them, and it is the
 * only such statement this app has — so it decides the *half* of the feed a
 * post lands in, and nothing else does. Within each half the order is arbitrary
 * on purpose: a feed sorted by time hands the top of the screen to whoever
 * posted most recently, for ever.
 */
export function orderFeed(posts, { followedIds = null, seed = 0 } = {}) {
  const followed = [];
  const rest = [];
  for (const post of posts || []) {
    if (followedIds?.has(post?.authorId)) followed.push(post);
    else rest.push(post);
  }
  return [...shuffleStable(followed, seed), ...shuffleStable(rest, seed)];
}
