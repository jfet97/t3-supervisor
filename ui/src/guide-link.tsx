import {createContext, useContext, type ComponentProps} from "react";
import {directoryRoute, RouteLink, routeHref, type Route} from "./navigation.js";

// share only the guarded navigation callback; the existing Atom remains the single owner of route state
export const GuideNavigation = createContext<((route: Route) => void) | null>(null);

/** Guide topics own their focus on entry, reload and browser traversal. */
export function focusGuideTopic(topic?: string) {
  if (typeof document === "undefined") return;
  const target = topic ? document.getElementById(`guide-${topic}-title`) : null;
  const heading = target ?? document.getElementById("steps-guide-title");
  if (!heading) return;
  heading.focus({preventScroll: true});
  heading.scrollIntoView({block: "start"});
  // leave the heading below the actual sticky header, including when its height changes with text or viewport size
  const header = document.querySelector<HTMLElement>(".app-header");
  const minimumTop = Math.max(0, header?.getBoundingClientRect().bottom ?? 0) + 24;
  const top = heading.getBoundingClientRect().top;
  if (top < minimumTop) window.scrollBy({top: top - minimumTop, behavior: "instant"});
}

// standalone rendered documentation keeps real links; the dashboard supplies its guarded navigator and list-scroll capture
export function GuideLink({topic, children, ...props}: Omit<ComponentProps<"a">, "href"> & {topic: string}) {
  const navigate = useContext(GuideNavigation);
  const to = {...directoryRoute, page: "guide" as const, guideTopic: topic};
  const href = routeHref(to);
  const onClick: ComponentProps<"a">["onClick"] = event => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (window.location.hash === href) {event.preventDefault();focusGuideTopic(topic);}
  };
  return navigate ? <RouteLink {...props} to={to} navigate={navigate} onClick={onClick}>{children}</RouteLink>
    : <a {...props} href={href} onClick={onClick}>{children}</a>;
}
