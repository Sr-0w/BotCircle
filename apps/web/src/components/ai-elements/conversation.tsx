
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { type RefObject, createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

type ReadingPosition = { top: number; selector?: string; offset?: number };
const positions = new Map<string, ReadingPosition>();

// Capture once on navigation. The browser handles anchoring during live updates.
function readingPosition(el: HTMLElement): ReadingPosition {
  const top = el.getBoundingClientRect().top;
  for (const row of el.querySelectorAll<HTMLElement>('[id^="message-"], [data-scroll-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= top || rect.height === 0) continue;
    const selector = row.id ? "#" + CSS.escape(row.id) : "[data-scroll-key=" + CSS.escape(row.dataset.scrollKey!) + "]";
    return { top: el.scrollTop, selector, offset: rect.top - top };
  }
  return { top: el.scrollTop };
}
const ViewportContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
const ScrollContext = createContext({ following: true, latest: () => {} });
export type ConversationProps = ComponentProps<"div"> & { timelineId?: string };

export function Conversation({ className, children, timelineId, ...props }: ConversationProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const intent = useRef(true);
  const [following, setFollowing] = useState(true);
  const follow = useCallback((value: boolean) => {
    if (intent.current !== value) {
      intent.current = value;
      setFollowing(value);
    }
  }, []);
  const latest = () => {
    follow(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  useLayoutEffect(() => {
    const el = viewport.current!;
    let saved = timelineId ? positions.get(timelineId) : undefined;
    follow(saved === undefined);
    const restore = () => {
      if (saved === undefined) return;
      const row = saved.selector ? el.querySelector(saved.selector) : null;
      const target = row ? el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - (saved.offset ?? 0) : saved.top;
      el.scrollTop = target;
      if (row || Math.abs(el.scrollTop - target) < 1) saved = undefined;
    };
    if (intent.current) el.scrollTop = el.scrollHeight;
    else restore();
    let downward = false;
    let previousTop = el.scrollTop;
    let dragging = false;
    let touchY = 0;
    const atEnd = () => el.scrollHeight - el.clientHeight - el.scrollTop <= 4;
    const direction = (delta: number) => {
      if (!delta) return;
      saved = undefined;
      downward = delta > 0;
      if (!downward && el.scrollTop > 0) follow(false);
      if (downward && atEnd()) follow(true);
    };
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) direction(e.deltaY); };
    const start = (e: TouchEvent) => { touchY = e.touches[0].clientY; };
    const move = (e: TouchEvent) => {
      direction(touchY - e.touches[0].clientY);
      touchY = e.touches[0].clientY;
    };
    const key = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key !== " ") return;
      if ((e.target as HTMLElement).closest("input,textarea,button,[contenteditable=true]")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) direction(-1);
      if (e.key === "End") {
        e.preventDefault();
        follow(true);
        el.scrollTop = el.scrollHeight;
      }
      if (["ArrowDown", "PageDown"].includes(e.key)) direction(1);
      if (e.key === " ") direction(e.shiftKey ? -1 : 1);
    };
    const detach = () => { saved = undefined; downward = false; follow(false); };
    const down = (e: PointerEvent) => {
      dragging = e.clientX >= el.getBoundingClientRect().left + el.clientWidth;
      if (dragging) detach();
    };
    const up = () => { dragging = false; };
    const selected = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && el.contains(selection.anchorNode)) detach();
    };
    const scroll = () => {
      const top = el.scrollTop;
      if (dragging && top < previousTop) follow(false);
      if (top > previousTop && (downward || dragging) && atEnd()) {
        follow(true);
        downward = false;
      }
      previousTop = top;
    };
    // Chromium anchors the visible content while detached. Only a following viewport needs a write.
    const resize = new ResizeObserver(() => {
      previousTop = el.scrollTop;
      if (intent.current) el.scrollTop = el.scrollHeight;
      else restore();
    });
    resize.observe(el);
    resize.observe(el.firstElementChild!);
    const controller = new AbortController();
    const options = { signal: controller.signal, passive: true };
    el.addEventListener("wheel", wheel, options);
    el.addEventListener("keydown", key, { signal: controller.signal });
    el.addEventListener("touchstart", start, options);
    el.addEventListener("touchmove", move, options);
    el.addEventListener("pointerdown", down, options);
    window.addEventListener("pointerup", up, options);
    el.addEventListener("contextmenu", detach, options);
    document.addEventListener("selectionchange", selected, options);
    el.addEventListener("od:stop-stick", detach, options);
    el.addEventListener("scroll", scroll, options);
    el.addEventListener("scrollend", () => { downward = false; }, options);
    return () => {
      if (timelineId) {
        if (intent.current) positions.delete(timelineId);
        else positions.set(timelineId, saved ?? readingPosition(el));
      }
      controller.abort();
      resize.disconnect();
    };
  }, [timelineId, follow]);

  return <ScrollContext.Provider value={{ following, latest }}>
    <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)} {...props}>
      <ViewportContext.Provider value={viewport}>{children}</ViewportContext.Provider>
    </div>
  </ScrollContext.Provider>;
}

export type ConversationContentProps = ComponentProps<"div">;
export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <div role="log" tabIndex={0} ref={useContext(ViewportContext)} className="absolute inset-0 overflow-y-auto">
    <div className={cn("flex flex-col gap-8 p-4", className)} {...props} />
  </div>
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { following, latest } = useContext(ScrollContext);


  return (
    !following && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        aria-label={t("Aller au dernier message")}
        onClick={latest}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (
    message: UIMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
