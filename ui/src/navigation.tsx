import React from "react";
import { useAtomValue } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { uiRuntime } from "./atoms.js";

const sections = ["task", "supervision", "definitions", "settings", "conversations", "connected", "editor"] as const;
export type ProjectSection = typeof sections[number];
export type Route = {page: "home" | "projects" | "activity" | "settings" | "guide"; projectId: string; main: string | null; section: ProjectSection; q?: string; listPage?: number; checkout?: string; definition?: string; showOrphaned?: boolean; workProject?: string; workFilter?: "all" | "attention" | "active" | "stopped"; guideTopic?: string};
export const directoryRoute: Route = {page: "projects", projectId: "", main: null, section: "conversations"};
/** The views of one main conversation. */
export const conversationSections: readonly ProjectSection[] = ["task", "supervision", "connected"];
export const isConversationView = (route: Route) => route.main !== null && route.main !== "" && conversationSections.includes(route.section);
export const homeRoute: Route = {...directoryRoute, page: "home"};
export const projectSections: readonly ProjectSection[] = sections;
export type NavigationGuard = (next: Route) => boolean;

export function parseRoute(hash: string): Route {
  try {
    const url = new URL(hash.replace(/^#/, "") || "/home", "http://supervisor.local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const page = parts[0];
    if (page === "projects") {
      const main = url.searchParams.get("main");
      const section = projectSections.find(value => value === parts[2]) ?? (main ? "task" : "conversations");
      const q = url.searchParams.get("q") ?? "";
      const listPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const checkout = ["definitions", "editor"].includes(section) ? url.searchParams.get("checkout") : null;
      const definition = section === "definitions" ? url.searchParams.get("definition") : null;
      return {...directoryRoute, projectId: parts[1] ?? "", section, main, ...(q ? {q} : {}), ...(listPage > 1 ? {listPage} : {}), ...(checkout ? {checkout} : {}), ...(definition ? {definition} : {}), ...(url.searchParams.get("orphaned") === "show" ? {showOrphaned: true} : {})};
    }
    if (page === "home") {
      const q = url.searchParams.get("q") ?? ""; const workProject = url.searchParams.get("project") ?? "";
      const filter = url.searchParams.get("filter"); const workFilter = filter === "attention" || filter === "active" || filter === "stopped" ? filter : "all";
      const listPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
      return {...homeRoute, ...(q ? {q} : {}), ...(workProject ? {workProject} : {}), ...(workFilter !== "all" ? {workFilter} : {}), ...(listPage > 1 ? {listPage} : {})};
    }
    if (page === "guide") {
      const topic = url.searchParams.get("topic") ?? "";
      return {...directoryRoute, page, ...(/^[a-z][a-z0-9-]{0,95}$/u.test(topic) ? {guideTopic: topic} : {})};
    }
    if (page === "activity") {
      const q = url.searchParams.get("q") ?? "";
      const listPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
      return {...directoryRoute, page, ...(q ? {q} : {}), ...(listPage > 1 ? {listPage} : {})};
    }
    if (page === "settings") return {...directoryRoute, page};
  } catch { /* Invalid addresses return to the project directory. */ }
  return directoryRoute;
}

export function routeHref(route: Route): string {
  const params = new URLSearchParams();
  if (route.page === "guide") {
    if (route.guideTopic) params.set("topic", route.guideTopic);
    return `#/guide${params.size ? `?${params}` : ""}`;
  }
  if (route.page === "home") {
    if (route.q) params.set("q", route.q);
    if ((route.listPage ?? 1) > 1) params.set("page", String(route.listPage));
    if (route.workProject) params.set("project", route.workProject);
    if (route.workFilter && route.workFilter !== "all") params.set("filter", route.workFilter);
    return `#/home${params.size ? `?${params}` : ""}`;
  }
  if (route.page === "activity") {
    if (route.q) params.set("q", route.q);
    if ((route.listPage ?? 1) > 1) params.set("page", String(route.listPage));
    return `#/activity${params.size ? `?${params}` : ""}`;
  }
  if (route.page !== "projects" || !route.projectId) return `#/${route.page}`;
  if (route.showOrphaned) params.set("orphaned", "show");
  if (route.main !== null) params.set("main", route.main);
  if (route.q) params.set("q", route.q);
  if ((route.listPage ?? 1) > 1) params.set("page", String(route.listPage));
  if (route.checkout && ["definitions", "editor"].includes(route.section)) params.set("checkout", route.checkout);
  if (route.definition && route.section === "definitions") params.set("definition", route.definition);
  const query = params.size ? `?${params}` : "";
  return `#/projects/${encodeURIComponent(route.projectId)}/${route.section}${query}`;
}

// the chat and section last opened in a project, kept for this tab in sessionStorage; stored values are untrusted
const RememberedContext = Schema.fromJsonString(Schema.Struct({main: Schema.String, section: Schema.Literals(sections)}));
const decodeRemembered = Schema.decodeUnknownOption(RememberedContext);
const encodeRemembered = Schema.encodeSync(RememberedContext);

export function rememberContext(route: Route) {
  if (route.projectId && route.main === null && route.section === "conversations") {
    try {sessionStorage.setItem(`supervisor-list:${route.projectId}`, routeHref(route));} catch { /* storage is optional */ }
  }
  if (!route.projectId || route.main === null) return;
  try { sessionStorage.setItem(`supervisor-context:${route.projectId}`, encodeRemembered({main: route.main, section: route.section})); } catch { /* Navigation also works without storage. */ }
}

export function openProject(projectId: string): Route {
  try {
    const stored = sessionStorage.getItem(`supervisor-list:${projectId}`);
    const list = stored ? parseRoute(stored) : null;
    if (list?.projectId === projectId && list.main === null && list.section === "conversations") return list;
  } catch { /* storage is optional */ }
  return {...directoryRoute, projectId};
}
export function rememberedConversation(projectId: string): Route | null {
  let stored: string | null = null;
  try {stored = sessionStorage.getItem(`supervisor-context:${projectId}`);} catch { /* storage is optional */ }
  return Option.match(decodeRemembered(stored), {onNone: () => null, onSome: ({main, section}) => main ? {...directoryRoute, projectId, main, section} : null});
}


type HistoryState = {hash: string; state: unknown; index?: number | null; length?: number};
export type NavigationHistory = {
  read: () => HistoryState;
  push: (href: string, state: object) => void;
  replace: (href: string, state: object) => void;
  go: (delta: number) => void;
  later?: (callback: () => void, ms: number) => void;
};
const restoreTimeoutMs = 1000;
const maxRestoreSteps = 100;
const historyOf = (state: unknown): string | null => typeof state === "object" && state !== null && "supervisorHistory" in state && typeof state.supervisorHistory === "string" ? state.supervisorHistory : null;
const markerOf = (state: unknown): number | null => typeof state === "object" && state !== null && "supervisorPosition" in state && Number.isSafeInteger(state.supervisorPosition) ? state.supervisorPosition as number : null;
const newHistory = () => Math.random().toString(36).slice(2);

// positions are relative entry indices; without the Navigation API, entries this page has not marked have unknown positions
export function createNavigator(initial: Route, host: NavigationHistory, allow: NavigationGuard, changed: (route: Route) => void) {
  let route = initial;
  const first = host.read();
  const adopted = historyOf(first.state);
  let lineage = adopted ?? newHistory();
  // a new lineage always starts at 0, so markers written without a lineage are never reused as positions
  let position: number | null = first.index ?? (adopted ? markerOf(first.state) : null) ?? 0;
  let unknownHash: string | null = null;
  let length = first.length;
  let restore: {token: number; mode: "exact" | "forward" | "back"; rejected: number | null; from: string | null; steps: number} | null = null;
  let tokens = 0;
  const positionAt = (observed: HistoryState) => observed.index ?? (historyOf(observed.state) === lineage ? markerOf(observed.state) : null);
  const stateAt = (index: number) => { const previous = host.read().state; return {...(typeof previous === "object" && previous !== null ? previous : {}), supervisorPosition: index, supervisorHistory: lineage}; };
  const synced = () => { length = host.read().length; };
  const accept = (next: Route) => { route = next; changed(next); };
  const indexed = (index: number) => { position = index; unknownHash = null; };
  const unindexed = (hash: string) => { position = null; unknownHash = hash; };
  const mark = (href: string) => {
    if (position === null) { lineage = newHistory(); indexed(0); } else indexed(position + 1);
    host.replace(href, stateAt(position!));
    synced();
  };
  const restart = () => { lineage = newHistory(); indexed(0); host.push(routeHref(route), stateAt(0)); synced(); };
  const recover = () => {
    // a requested traversal produced no event; resynchronize without overwriting an entry whose position is unknown
    restore = null;
    const observed = host.read();
    const target = positionAt(observed);
    if (target === null) { if (position !== null || observed.hash !== unknownHash) restart(); return; }
    if (routeHref(parseRoute(observed.hash)) !== routeHref(route)) { restart(); return; }
    indexed(target);
    synced();
  };
  const traverse = (delta: number, mode: "exact" | "forward" | "back", rejected: number | null, from: string | null, steps: number) => {
    const token = ++tokens;
    restore = {token, mode, rejected, from, steps};
    host.go(delta);
    host.later?.(() => { if (restore?.token === token) recover(); }, restoreTimeoutMs);
  };
  // moves from a rejected entry back to the entry the page shows; unindexed history is walked one entry at a time
  const towardCurrent = (observed: HistoryState, target: number | null, steps: number) => {
    if (steps > maxRestoreSteps) { restore = null; restart(); }
    else if (target !== null && position !== null) traverse(position - target, "exact", target, null, steps);
    else if (target !== null) traverse(-(target + 1), "back", target, observed.hash, steps);
    else traverse(1, "forward", null, observed.hash, steps);
  };
  const continueRestore = (observed: HistoryState, target: number | null, next: Route): boolean => {
    const pending = restore!;
    if (target !== null && target === position) {
      // an entry claiming the current position with another route has an inconsistent marker; keep it and continue from a new entry
      restore = null;
      if (routeHref(next) !== routeHref(route)) restart(); else synced();
      return true;
    }
    if (target !== null && target === pending.rejected) return true;
    if (pending.mode === "exact") { restore = null; return false; }
    if (target !== null) {
      if (pending.mode === "forward") towardCurrent(observed, target, pending.steps + 1);
      else { restore = null; restart(); }
      return true;
    }
    if (observed.hash === pending.from) return true;
    if (position === null && observed.hash === unknownHash) { restore = null; synced(); return true; }
    if (pending.steps >= maxRestoreSteps) { restore = null; restart(); return true; }
    traverse(pending.mode === "back" ? -1 : 1, pending.mode, null, observed.hash, pending.steps + 1);
    return true;
  };
  return {
    start: () => { host.replace(routeHref(route), stateAt(position ?? 0)); synced(); },
    navigate(next: Route, options?: {replace?: boolean}) {
      rememberListScroll(route);
      if (restore || routeHref(next) === routeHref(route) || !allow(next)) return;
      if (options?.replace) {host.replace(routeHref(next), stateAt(position ?? 0)); synced(); accept(next); return;}
      if (position === null) { route = next; restart(); changed(next); return; }
      host.push(routeHref(next), stateAt(position + 1));
      indexed(host.read().index ?? position + 1);
      synced();
      accept(next);
    },
    historyChanged() {
      const observed = host.read();
      const target = positionAt(observed);
      const next = parseRoute(observed.hash);
      // popstate and hashchange can describe the same traversal before the destination frame restores its position
      if (routeHref(next) !== routeHref(route)) rememberListScroll(route);
      if (restore && continueRestore(observed, target, next)) return;
      // a changed history length means the browser added this entry right after the current one
      const added = target === null && (observed.length === undefined || observed.length !== length);
      if (routeHref(next) === routeHref(route)) {
        if (target !== null) indexed(target);
        else if (added) mark(routeHref(route));
        else unindexed(observed.hash);
        synced();
        return;
      }
      if (!allow(next)) {
        if (added) mark(routeHref(route));
        else if (target !== null && target === position) { host.replace(routeHref(route), stateAt(target)); synced(); }
        else towardCurrent(observed, target, 0);
        return;
      }
      if (target !== null) indexed(target);
      else if (added) mark(routeHref(next));
      else unindexed(observed.hash);
      synced();
      accept(next);
    },
  };
}

// the route of this page and its guarded navigator; history and hash events feed the route, the bounded restore timer
// runs on the page runtime's clock, and the listeners and the timer are released with the atom (the residual history
// adapter, plan section 9)
export interface Navigation {
  readonly route: Route;
  readonly navigate: (next: Route, options?: {replace?: boolean}) => void;
  readonly guard: {current: NavigationGuard};
}
export const navigationAtom: Atom.Atom<Navigation> = Atom.make((get) => {
  const guard = {current: (() => true) as NavigationGuard};
  // the latest restore deadline; a newer one replaces it, and the navigator ignores a superseded deadline anyway
  const deadline = Atom.make<{readonly callback: () => void; readonly ms: number} | null>(null);
  get.mount(uiRuntime.atom((get) => {
    const pending = get(deadline);
    return pending === null ? Effect.void : Effect.sleep(pending.ms).pipe(Effect.andThen(Effect.sync(pending.callback)));
  }));
  const initial = parseRoute(window.location.hash);
  let current: Navigation = {route: initial, navigate: (next, options) => controller.navigate(next, options), guard};
  const controller = createNavigator(initial, {
    read: () => ({hash: window.location.hash, state: history.state, index: window.navigation?.currentEntry?.index ?? null, length: history.length}),
    push: (href, state) => history.pushState(state, "", href),
    replace: (href, state) => history.replaceState(state, "", href),
    go: delta => history.go(delta),
    later: (callback, ms) => get.set(deadline, {callback, ms}),
  }, next => guard.current(next), next => { rememberContext(next); current = {...current, route: next}; get.setSelf(current); });
  controller.start();
  rememberContext(current.route);
  const changed = () => {
    const before = current.route;
    controller.historyChanged();
    if (current.route !== before) focusAfterNavigation(before, current.route, true);
  };
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  get.addFinalizer(() => { window.removeEventListener("hashchange", changed); window.removeEventListener("popstate", changed); });
  return current;
});

const listScrollKey = (route: Route) => route.page === "projects"
  ? `supervisor-list-scroll:${route.projectId}:${route.q ?? ""}:${route.listPage ?? 1}`
  : `supervisor-list-scroll:${routeHref(route)}`;
const isProjectList = (route: Route) => route.page === "projects" && route.projectId && route.main === null && route.section === "conversations";
const isScrollableList = (route: Route) => isProjectList(route) || route.page === "home" || route.page === "activity";
const rememberListScroll = (route: Route) => {
  if (!isScrollableList(route)) return;
  try {sessionStorage.setItem(listScrollKey(route), String(window.scrollY));} catch { /* storage is optional */ }
};

/**
 * The control that reopens the view a same-view change leaves, matched by its `data-route-return` value: a folder choice
 * collapses the chooser into Change working folder, Back to catalog restores the opened entry and Back to Definitions restores
 * Edit project.yaml.
 */
export const returnFocus = (previous: Route, next: Route): string | null =>
  (previous.checkout ?? "") !== (next.checkout ?? "") ? "checkout"
    : previous.definition && !next.definition ? `definition:${previous.definition}`
      : previous.section === "editor" && next.section === "definitions" ? "editor" : null;

/** Navigates and, when the navigation guard accepted the destination, moves focus there as an activated link does. */
export function navigateWithFocus(navigate: (route: Route) => void, previous: Route, next: Route) {
  navigate(next);
  if (routeHref(parseRoute(window.location.hash)) === routeHref(next)) focusAfterNavigation(previous, next);
}

const shown = (element: HTMLElement) => !element.closest("[hidden]") && element.getClientRects().length > 0;
// the shown view's own target: the element it marks for arrival, else its page heading
const viewTarget = () => [...document.querySelectorAll<HTMLElement>("#workspace [data-route-focus]")].find(shown)
  ?? [...document.querySelectorAll<HTMLElement>("#workspace h1")].find(element => shown(element) && !element.closest(".sr-only"));
const focusTarget = (target: HTMLElement, block: ScrollLogicalPosition) => {
  if (!target.matches("a[href], button, input, select, textarea, summary")) target.tabIndex = -1;
  target.focus({preventScroll: true});
  target.scrollIntoView?.({block});
};

/**
 * Signing in again removes the sign-in form while the retained view reappears. Focus moves to that view's alert that takes
 * focus (an unconfirmed save outcome), else to the view's own target; a focused control that survived keeps focus.
 */
export function focusRetainedView() {
  if (typeof requestAnimationFrame !== "function" || typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && shown(active)) return;
    const target = [...document.querySelectorAll<HTMLElement>("#workspace [role=alert][tabindex='-1']")].find(shown) ?? viewTarget();
    if (target) focusTarget(target, "center");
  });
}

/** The native frame adapter focuses the destination and restores retained list positions. */
export function focusAfterNavigation(previous: Route, next: Route, restoreListPosition = false) {
  // the mounted Guide focuses its topic after rendering, including initial loads and query-only changes
  if (next.page === "guide") return;
  if (typeof requestAnimationFrame !== "function" || typeof document === "undefined") return;
  if (previous.page === next.page && previous.projectId === next.projectId && previous.main === next.main && next.projectId) {
    /*
      Within one project or conversation a filter, switch or pager stays mounted and keeps focus, and a section link keeps it
      within its navigation on the link that now marks the destination, after a click or a history step. When the destination
      replaced the activated control (a catalog entry, Back to catalog, the editor link or a folder choice), or a surviving
      shortcut such as Review project changes or a breadcrumb led elsewhere, focus moves to the control a return restores or
      to the destination's own target instead of staying behind.
    */
    requestAnimationFrame(() => {
      const back = returnFocus(previous, next);
      const returned = back === null ? undefined : [...document.querySelectorAll<HTMLElement>("#workspace [data-route-return]")].find(element => element.dataset.routeReturn === back && shown(element));
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body && shown(document.activeElement) ? document.activeElement : null;
      if (!returned && active?.matches("button, input, select, textarea, summary")) return;
      const current = active?.closest("nav")?.querySelector<HTMLElement>("a[aria-current=page]");
      const target = returned ?? (current && shown(current) ? current : viewTarget());
      if (!target || target === active) return;
      // a restored entry returns to the middle of the view with its neighbours; a destination target only needs to be visible
      focusTarget(target, target === returned ? "center" : "nearest");
    });
    return;
  }
  requestAnimationFrame(() => {
    const heading = [...document.querySelectorAll<HTMLElement>("#workspace h1")].find(element => !element.closest("[hidden]") && !element.closest(".sr-only"));
    let top = 0;
    if (isProjectList(next) || restoreListPosition && isScrollableList(next)) try {top = Number(sessionStorage.getItem(listScrollKey(next))) || 0;} catch { /* storage is optional */ }
    window.scrollTo({top, behavior: "instant"});
    const rows = isProjectList(next) ? [...document.querySelectorAll<HTMLAnchorElement>(".conversation-list > a")] : [];
    const selected = rows.find(row => parseRoute(new URL(row.href).hash).main === previous.main);
    const visible = rows.find(row => {const rect = row.getBoundingClientRect();return rect.top >= 0 && rect.bottom <= window.innerHeight;});
    const visibleControl = top > 0 && !isProjectList(next) ? [...document.querySelectorAll<HTMLElement>("#workspace a[href], #workspace button:not(:disabled), #workspace summary, #workspace input:not(:disabled), #workspace select:not(:disabled)")].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top >= Math.max(0, document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0) && rect.bottom <= window.innerHeight;
    }) : null;
    const target = top > 0 ? selected ?? visible ?? visibleControl ?? heading : heading;
    if (target) {if (target === heading) target.tabIndex = -1; target.focus({preventScroll: true});}
  });
}

export function useNavigation(): Navigation {
  return useAtomValue(navigationAtom);
}

export function RouteLink({to, navigate, children, ...props}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {to: Route; navigate: (route: Route) => void}) {
  return <a {...props} href={routeHref(to)} onClick={event => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateWithFocus(navigate, parseRoute(window.location.hash), to);
  }}>{children}</a>;
}
