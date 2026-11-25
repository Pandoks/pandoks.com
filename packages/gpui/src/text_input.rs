use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId,
    InspectorElementId, InteractiveElement, IntoElement, KeyBinding, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, ParentElement, Pixels, Point,
    Refineable, Render, Role, ShapedLine, SharedString, StatefulInteractiveElement, Style,
    StyleRefinement, Styled, TextAlign, TextRun, UTF16Selection, UnderlineStyle, Window, actions,
    div, fill, point, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::Theme;

const KEY_CONTEXT: &str = "TextInput";

actions!(
    pandoks_text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        Home,
        End,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Submit,
    ]
);

pub(crate) fn register_keybindings(cx: &mut App) {
    let mut bindings = vec![
        KeyBinding::new("backspace", Backspace, Some(KEY_CONTEXT)),
        KeyBinding::new("delete", Delete, Some(KEY_CONTEXT)),
        KeyBinding::new("left", Left, Some(KEY_CONTEXT)),
        KeyBinding::new("right", Right, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-left", SelectLeft, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-right", SelectRight, Some(KEY_CONTEXT)),
        KeyBinding::new("home", Home, Some(KEY_CONTEXT)),
        KeyBinding::new("end", End, Some(KEY_CONTEXT)),
        KeyBinding::new("enter", Submit, Some(KEY_CONTEXT)),
    ];

    #[cfg(target_os = "macos")]
    bindings.extend([
        KeyBinding::new("cmd-left", Home, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-right", End, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-a", SelectAll, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-c", Copy, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-x", Cut, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-v", Paste, Some(KEY_CONTEXT)),
    ]);

    #[cfg(not(target_os = "macos"))]
    bindings.extend([
        KeyBinding::new("ctrl-a", SelectAll, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-c", Copy, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-x", Cut, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-v", Paste, Some(KEY_CONTEXT)),
    ]);

    cx.bind_keys(bindings);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextInputEvent {
    Change(SharedString),
    Submit(SharedString),
}

pub struct TextInput {
    focus_handle: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    scroll_offset_x: Pixels,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    style: StyleRefinement,
}

impl EventEmitter<TextInputEvent> for TextInput {}

impl Styled for TextInput {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl TextInput {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: SharedString::default(),
            placeholder: SharedString::default(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            scroll_offset_x: px(0.0),
            last_layout: None,
            last_bounds: None,
            is_selecting: false,
            style: StyleRefinement::default(),
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn value(&self) -> &str {
        self.content.as_ref()
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus_handle, cx);
    }

    pub fn set_value(
        &mut self,
        value: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = sanitize_single_line(&value.into());
        let len = next.len();
        self.content = next.into();
        self.selected_range = len..len;
        self.selection_reversed = false;
        self.marked_range = None;
        self.scroll_offset_x = px(0.0);
        window.notify_text_input_changed(&self.focus_handle);
        cx.emit(TextInputEvent::Change(self.content.clone()));
        cx.notify();
    }

    pub fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.content.is_empty() && self.marked_range.is_none() {
            return;
        }
        self.set_value("", window, cx);
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), window, cx);
        } else {
            self.move_to(self.selected_range.start, window, cx);
        }
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), window, cx);
        } else {
            self.move_to(self.selected_range.end, window, cx);
        }
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_range = 0..self.content.len();
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let prev = self.previous_boundary(self.cursor_offset());
            if self.cursor_offset() == prev {
                return;
            }
            self.select_to(prev, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if self.cursor_offset() == next {
                return;
            }
            self.select_to(next, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let single_line = sanitize_single_line(&text);
            self.replace_text_in_range(None, &single_line, window, cx);
        }
    }

    fn submit(&mut self, _: &Submit, _window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextInputEvent::Submit(self.content.clone()));
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        let offset = self.index_for_mouse_position(event.position);
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(offset, window, cx);
        } else {
            self.move_to(offset, window, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), window, cx);
        }
    }

    fn move_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        let clamped = offset.min(self.content.len());
        self.selected_range = clamped..clamped;
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        let clamped = offset.min(self.content.len());
        if self.selection_reversed {
            self.selected_range.start = clamped;
        } else {
            self.selected_range.end = clamped;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.content.len();
        }
        line.closest_index_for_x(position.x - bounds.left() + self.scroll_offset_x)
    }

    fn splice_text(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
    ) -> (usize, usize, usize) {
        let sanitized = sanitize_single_line(new_text);
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());

        let mut next =
            String::with_capacity(self.content.len() - (range.end - range.start) + sanitized.len());
        next.push_str(&self.content[0..range.start]);
        next.push_str(&sanitized);
        next.push_str(&self.content[range.end..]);

        self.content = next.into();
        (
            range.start,
            sanitized.len(),
            sanitized.encode_utf16().count(),
        )
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.content.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        let mut utf8 = 0;
        for ch in self.content.chars() {
            if utf8 >= offset {
                break;
            }
            utf8 += ch.len_utf8();
            utf16 += ch.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selected_range = self.range_from_utf16(&range_utf16);
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (start, inserted_len, _) = self.splice_text(range_utf16, new_text);
        let caret = start + inserted_len;
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.emit(TextInputEvent::Change(self.content.clone()));
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (start, inserted_len, inserted_utf16) = self.splice_text(range_utf16, new_text);
        self.marked_range = (inserted_len > 0).then_some(start..start + inserted_len);
        let start_utf16 = self.offset_to_utf16(start);
        self.selected_range = new_selected_range_utf16
            .map(|selected| {
                self.range_from_utf16(
                    &(start_utf16 + selected.start.min(inserted_utf16)
                        ..start_utf16 + selected.end.min(inserted_utf16)),
                )
            })
            .unwrap_or_else(|| start + inserted_len..start + inserted_len);
        self.selection_reversed = false;

        window.notify_text_input_changed(&self.focus_handle);
        cx.emit(TextInputEvent::Change(self.content.clone()));
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let last_layout = self.last_layout.as_ref()?;
        if last_layout.text != self.content {
            return None;
        }
        let range = self.range_from_utf16(&range_utf16);
        Some(Bounds::from_corners(
            point(
                bounds.left() + last_layout.x_for_index(range.start) - self.scroll_offset_x,
                bounds.top(),
            ),
            point(
                bounds.left() + last_layout.x_for_index(range.end) - self.scroll_offset_x,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let line_point = self.last_bounds?.localize(&point)?;
        let last_layout = self.last_layout.as_ref()?;
        if last_layout.text != self.content {
            return None;
        }
        let utf8_index = last_layout.closest_index_for_x(line_point.x + self.scroll_offset_x);
        Some(self.offset_to_utf16(utf8_index))
    }
}

struct TextInputElement {
    input: Entity<TextInput>,
}

struct TextInputPrepaint {
    line: Option<ShapedLine>,
    scroll_offset_x: Pixels,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
}

impl Element for TextInputElement {
    type RequestLayoutState = ();
    type PrepaintState = TextInputPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let theme = Theme::of(window);
        let input = self.input.read(cx);
        let content = input.content.clone();
        let selected_range = input.selected_range.clone();
        let cursor = input.cursor_offset();
        let style = window.text_style();
        let mut scroll_offset_x = input.scroll_offset_x;

        let (display_text, text_color) = if content.is_empty() {
            (input.placeholder.clone(), theme.muted_foreground)
        } else {
            (content.clone(), style.color)
        };

        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };

        let runs = if let Some(marked_range) = input.marked_range.as_ref() {
            vec![
                TextRun {
                    len: marked_range.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked_range.end - marked_range.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display_text.len().saturating_sub(marked_range.end),
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect()
        } else {
            vec![run]
        };

        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(display_text, font_size, &runs, None);

        let cursor_x = if content.is_empty() {
            px(0.0)
        } else {
            line.x_for_index(cursor)
        };

        let viewport_width = bounds.size.width;
        if content.is_empty() || line.width <= viewport_width {
            scroll_offset_x = px(0.0);
        } else {
            let max_scroll = (line.width - viewport_width + px(2.0)).max(px(0.0));
            if cursor_x < scroll_offset_x {
                scroll_offset_x = cursor_x;
            } else if cursor_x > scroll_offset_x + viewport_width - px(2.0) {
                scroll_offset_x = cursor_x - viewport_width + px(2.0);
            }
            scroll_offset_x = scroll_offset_x.clamp(px(0.0), max_scroll);
        }

        let (selection, cursor_quad) = if selected_range.is_empty() || content.is_empty() {
            (
                None,
                Some(fill(
                    Bounds::new(
                        point(bounds.left() + cursor_x - scroll_offset_x, bounds.top()),
                        size(px(1.5), bounds.size.height),
                    ),
                    theme.foreground,
                )),
            )
        } else {
            let start_x = line.x_for_index(selected_range.start) - scroll_offset_x;
            let end_x = line.x_for_index(selected_range.end) - scroll_offset_x;
            (
                Some(fill(
                    Bounds::from_corners(
                        point(bounds.left() + start_x, bounds.top()),
                        point(bounds.left() + end_x, bounds.bottom()),
                    ),
                    theme.primary.opacity(0.2),
                )),
                None,
            )
        };

        TextInputPrepaint {
            line: Some(line),
            scroll_offset_x,
            cursor: cursor_quad,
            selection,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );

        let line = prepaint.line.take().unwrap();
        let scroll_offset_x = prepaint.scroll_offset_x;
        let is_focused = focus_handle.is_focused(window);

        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            if is_focused && let Some(selection) = prepaint.selection.take() {
                window.paint_quad(selection);
            }

            let origin = point(bounds.left() - scroll_offset_x, bounds.top());
            let _ = line.paint(
                origin,
                window.line_height(),
                TextAlign::Left,
                None,
                window,
                cx,
            );

            if is_focused && let Some(cursor) = prepaint.cursor.take() {
                window.paint_quad(cursor);
            }
        });

        self.input.update(cx, |input, _cx| {
            input.scroll_offset_x = scroll_offset_x;
            input.last_layout = Some(line);
            input.last_bounds = Some(bounds);
        });
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let focused = self.focus_handle.is_focused(window);
        let radius_md = theme.radius - px(2.0);
        let bg = if theme.dark {
            theme.input.opacity(0.3)
        } else {
            theme.background
        };
        let border = if focused { theme.ring } else { theme.input };

        let mut container = div()
            .id("text-input")
            .role(Role::TextInput)
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::submit))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .flex()
            .items_center()
            .h(px(36.0))
            .w_full()
            .min_w_0()
            .rounded(radius_md)
            .border_1()
            .border_color(border)
            .bg(bg)
            .px(px(12.0))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .text_color(theme.foreground);

        container.style().refine(&self.style);
        container.child(TextInputElement { input: cx.entity() })
    }
}

fn sanitize_single_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use gpui::{AppContext, TestAppContext, VisualTestContext};

    #[gpui::test]
    async fn editing_selection_clipboard_ime_and_submit(cx: &mut TestAppContext) {
        cx.update(|cx| crate::init(cx).expect("init pandoks-gpui"));

        let submitted = Rc::new(RefCell::new(Vec::<String>::new()));
        let submitted_clone = submitted.clone();

        let window = cx.add_window(|window, cx| {
            let input = TextInput::new(cx).placeholder("Add a task...");
            input.focus(window, cx);
            let entity = cx.entity();
            cx.subscribe(&entity, move |_, _, event, _| {
                if let TextInputEvent::Submit(text) = event {
                    submitted_clone.borrow_mut().push(text.to_string());
                }
            })
            .detach();
            input
        });

        let mut visual_cx = VisualTestContext::from_window(window.into(), cx);
        let input = window.root(&mut visual_cx).expect("root entity");
        visual_cx.run_until_parked();

        visual_cx
            .update_window(window.into(), |_, window, cx| {
                input.update(cx, |input, cx| {
                    input.replace_text_in_range(None, "Hello world", window, cx);
                });
            })
            .expect("update window");
        assert_eq!(
            input.read_with(&visual_cx, |i, _| i.value().to_owned()),
            "Hello world"
        );
        assert_eq!(input.read_with(&visual_cx, |i, _| i.cursor_offset()), 11);

        for _ in 0..5 {
            visual_cx.dispatch_action(SelectLeft);
        }
        assert_eq!(
            input.read_with(&visual_cx, |i, _| i.selected_range.clone()),
            6..11
        );
        visual_cx.dispatch_action(Copy);
        visual_cx
            .update_window(window.into(), |_, window, cx| {
                input.update(cx, |input, cx| {
                    input.replace_text_in_range(None, "GPUI", window, cx);
                });
            })
            .expect("update window");
        assert_eq!(
            input.read_with(&visual_cx, |i, _| i.value().to_owned()),
            "Hello GPUI"
        );

        visual_cx.dispatch_action(Home);
        assert_eq!(input.read_with(&visual_cx, |i, _| i.cursor_offset()), 0);
        visual_cx.dispatch_action(End);
        visual_cx
            .update_window(window.into(), |_, window, cx| {
                input.update(cx, |input, cx| {
                    input.replace_text_in_range(None, " ", window, cx);
                });
            })
            .expect("update window");
        visual_cx.dispatch_action(Paste);
        assert_eq!(
            input.read_with(&visual_cx, |i, _| i.value().to_owned()),
            "Hello GPUI world"
        );

        visual_cx
            .update_window(window.into(), |_, window, cx| {
                input.update(cx, |input, cx| {
                    input.replace_and_mark_text_in_range(None, "!", None, window, cx);
                    assert!(input.marked_text_range(window, cx).is_some());
                    input.replace_text_in_range(None, "?", window, cx);
                    assert!(input.marked_text_range(window, cx).is_none());
                });
            })
            .expect("update window");
        assert_eq!(
            input.read_with(&visual_cx, |i, _| i.value().to_owned()),
            "Hello GPUI world?"
        );

        visual_cx.dispatch_action(Submit);
        visual_cx.run_until_parked();
        assert_eq!(&*submitted.borrow(), &["Hello GPUI world?"]);

        visual_cx.dispatch_action(SelectAll);
        visual_cx.dispatch_action(Cut);
        assert_eq!(input.read_with(&visual_cx, |i, _| i.value().to_owned()), "");
    }
}
