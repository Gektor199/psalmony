// Keep the marketing site separate from the installable application's shell.
export function siteRoute(url) {
  if (url.pathname === '/' && url.searchParams.has('invite')) {
    return {redirect: '/app' + url.search};
  }
  const routes = {'/': 'site/index.html', '/app': 'index.html', '/app/': 'index.html', '/privacy': 'site/privacy.html', '/terms': 'site/terms.html', '/help': 'site/help.html'};
  return {file: routes[url.pathname] || null};
}
