export function isInlineSubscriptionEntry(item) {
  return item?.type === 'inline' && Array.isArray(item?.nodeUrls);
}

export function isRemoteSubscriptionEntry(item) {
  return typeof item?.url === 'string' && /^https?:\/\//i.test(item.url.trim());
}

export function isSubscriptionEntry(item) {
  return isRemoteSubscriptionEntry(item) || isInlineSubscriptionEntry(item);
}
