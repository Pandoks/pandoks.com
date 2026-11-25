use std::borrow::Cow;
use std::ops::Range;
use std::sync::Arc;

use gpui::{
    Action, App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, DispatchPhase,
    ElementInputHandler, EntityInputHandler, EventEmitter, FocusHandle, Focusable, Font,
    InteractiveElement, IntoElement, KeyBinding, LineLayout, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Refineable, Render, Role,
    ShapedLine, SharedString, StatefulInteractiveElement, StyleRefinement, Styled, TextAlign,
    TextRun, UTF16Selection, UnderlineStyle, Window, canvas, div, fill, point, px, size,
};
use unicode_segmentation::GraphemeCursor;

use crate::Theme;

const KEY_CONTEXT: &str = "TextInput";
const CARET_WIDTH: Pixels = px(1.5);

#[derive(Clone, Copy, PartialEq, Eq, Action)]
#[action(namespace = pandoks_text_input, no_json, no_register)]
enum InputAction {
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
}

pub(crate) fn register_keybindings(cx: &mut App) {
    use InputAction::*;
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some(KEY_CONTEXT)),
        KeyBinding::new("delete", Delete, Some(KEY_CONTEXT)),
        KeyBinding::new("left", Left, Some(KEY_CONTEXT)),
        KeyBinding::new("right", Right, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-left", SelectLeft, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-right", SelectRight, Some(KEY_CONTEXT)),
        KeyBinding::new("home", Home, Some(KEY_CONTEXT)),
        KeyBinding::new("end", End, Some(KEY_CONTEXT)),
        KeyBinding::new("enter", Submit, Some(KEY_CONTEXT)),
    ]);

    #[cfg(target_os = "macos")]
    cx.bind_keys([
        KeyBinding::new("cmd-left", Home, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-right", End, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-a", SelectAll, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-c", Copy, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-x", Cut, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-v", Paste, Some(KEY_CONTEXT)),
    ]);

    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([
        KeyBinding::new("ctrl-a", SelectAll, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-c", Copy, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-x", Cut, Some(KEY_CONTEXT)),
        KeyBinding::new("ctrl-v", Paste, Some(KEY_CONTEXT)),
    ]);
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
    anchor: usize,
    cursor: usize,
    marked_range: Option<Range<usize>>,
    scroll_offset_x: Pixels,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    last_text_style: Option<(Font, Pixels)>,
    is_selecting: bool,
    style: StyleRefinement,
}

impl EventEmitter<TextInputEvent> for TextInput {}

impl Styled for TextInput {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl TextInput {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        cx.on_blur(&focus_handle, window, Self::on_blur).detach();
        Self {
            focus_handle,
            content: SharedString::default(),
            placeholder: SharedString::default(),
            anchor: 0,
            cursor: 0,
            marked_range: None,
            scroll_offset_x: px(0.0),
            last_layout: None,
            last_bounds: None,
            last_text_style: None,
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
        self.apply_edit(0..self.content.len(), &value.into(), None, window, cx);
    }

    pub fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_value("", window, cx);
    }

    fn on_blur(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.is_selecting = false;
        if self.marked_range.take().is_some() {
            window.notify_text_input_changed(&self.focus_handle);
            cx.notify();
        }
    }

    fn selected_range(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }

    fn update_selection(&mut self, anchor: usize, cursor: usize) -> bool {
        let anchor = snap_grapheme_boundary(&self.content, anchor, true);
        let cursor = snap_grapheme_boundary(&self.content, cursor, true);
        if self.anchor == anchor && self.cursor == cursor {
            return false;
        }
        self.anchor = anchor;
        self.cursor = cursor;
        true
    }

    fn set_selection(
        &mut self,
        anchor: usize,
        cursor: usize,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let selection_changed = self.update_selection(anchor, cursor);
        let unmarked = self.marked_range.take().is_some();
        if !selection_changed && !unmarked {
            return;
        }
        if unmarked {
            window.notify_text_input_changed(&self.focus_handle);
        }
        window.notify_text_selection_changed(&self.focus_handle);
        if self.focus_handle.is_focused(window) {
            window.invalidate_character_coordinates();
        }
        cx.notify();
    }

    fn on_action(&mut self, action: &InputAction, window: &mut Window, cx: &mut Context<Self>) {
        match action {
            InputAction::Backspace => self.delete_direction(false, window, cx),
            InputAction::Delete => self.delete_direction(true, window, cx),
            InputAction::Left => self.move_horizontal(false, false, window, cx),
            InputAction::Right => self.move_horizontal(true, false, window, cx),
            InputAction::SelectLeft => self.move_horizontal(false, true, window, cx),
            InputAction::SelectRight => self.move_horizontal(true, true, window, cx),
            InputAction::Home => self.set_selection(0, 0, window, cx),
            InputAction::End => {
                let length = self.content.len();
                self.set_selection(length, length, window, cx);
            }
            InputAction::SelectAll => self.set_selection(0, self.content.len(), window, cx),
            InputAction::Copy => {
                self.copy_selection(cx);
            }
            InputAction::Cut => {
                if self.copy_selection(cx) {
                    self.apply_edit(self.selected_range(), "", None, window, cx);
                }
            }
            InputAction::Paste => {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.apply_edit(self.selected_range(), &text, None, window, cx);
                }
            }
            InputAction::Submit => cx.emit(TextInputEvent::Submit(self.content.clone())),
        }
    }

    fn move_horizontal(
        &mut self,
        forward: bool,
        select: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let range = self.selected_range();
        let next = if select || range.is_empty() {
            step_grapheme_boundary(&self.content, self.cursor, forward)
        } else if forward {
            range.end
        } else {
            range.start
        };
        let anchor = if select { self.anchor } else { next };
        self.set_selection(anchor, next, window, cx);
    }

    fn delete_direction(&mut self, forward: bool, window: &Window, cx: &mut Context<Self>) {
        let range = if self.anchor == self.cursor {
            let target = step_grapheme_boundary(&self.content, self.cursor, forward);
            self.cursor.min(target)..self.cursor.max(target)
        } else {
            self.selected_range()
        };
        self.apply_edit(range, "", None, window, cx);
    }

    fn copy_selection(&self, cx: &mut Context<Self>) -> bool {
        let range = self.selected_range();
        if range.is_empty() {
            return false;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(self.content[range].to_owned()));
        true
    }

    fn valid_layout(&self) -> Option<&ShapedLine> {
        self.last_layout
            .as_ref()
            .filter(|layout| layout.text == self.content)
    }

    fn live_layout_and_scroll(
        &self,
        bounds_width: Pixels,
        window: &Window,
    ) -> Option<(Arc<LineLayout>, Pixels)> {
        let layout = if let Some(line) = self.valid_layout() {
            Arc::clone(line)
        } else {
            let (font, font_size) = self.last_text_style.as_ref()?;
            let run = TextRun {
                len: self.content.len(),
                font: font.clone(),
                ..Default::default()
            };
            window
                .text_system()
                .layout_line(self.content.clone(), *font_size, &[run], None)
        };
        let scroll = scroll_offset_for(
            self.scroll_offset_x,
            layout.width,
            layout.x_for_index(self.cursor),
            bounds_width,
        );
        Some((layout, scroll))
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.valid_layout()) else {
            return self.cursor;
        };
        closest_grapheme_for_x(
            &self.content,
            line,
            position.x - bounds.left() + self.scroll_offset_x,
        )
    }

    fn ime_target_range(&self, range_utf16: Option<Range<usize>>) -> Range<usize> {
        range_utf16
            .map(|range| range_from_utf16(&self.content, &range))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range())
    }

    fn apply_edit(
        &mut self,
        range: Range<usize>,
        new_text: &str,
        mark_selection: Option<Option<Range<usize>>>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let sanitized = sanitize_single_line(new_text);
        let changed = &self.content[range.clone()] != sanitized.as_ref();
        if changed {
            let mut next = String::with_capacity(
                self.content.len() - (range.end - range.start) + sanitized.len(),
            );
            next.push_str(&self.content[..range.start]);
            next.push_str(&sanitized);
            next.push_str(&self.content[range.end..]);
            self.content = next.into();
        }

        let end = range.start + sanitized.len();
        let next_marked = (mark_selection.is_some() && !sanitized.is_empty()).then(|| {
            snap_grapheme_boundary(&self.content, range.start, false)
                ..snap_grapheme_boundary(&self.content, end, true)
        });
        let marked_changed = self.marked_range != next_marked;
        self.marked_range = next_marked;

        let (anchor, cursor) = match mark_selection.flatten() {
            Some(selection) => {
                let selected = range_from_utf16(&sanitized, &selection);
                (range.start + selected.start, range.start + selected.end)
            }
            None => (end, end),
        };
        let selection_changed = self.update_selection(anchor, cursor);

        if !changed && !marked_changed && !selection_changed {
            return;
        }
        window.notify_text_input_changed(&self.focus_handle);
        if self.focus_handle.is_focused(window) {
            window.invalidate_character_coordinates();
        }
        if changed {
            cx.emit(TextInputEvent::Change(self.content.clone()));
        }
        cx.notify();
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        self.content[..offset].encode_utf16().count()
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        let start = self.offset_to_utf16(range.start);
        let end = start + self.content[range.start..range.end].encode_utf16().count();
        start..end
    }

    fn paint_line(
        &mut self,
        outer_bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let theme = Theme::of(window);
        let style = window.text_style();
        let line_height = window.line_height();
        let line_top = outer_bounds.top() + (outer_bounds.size.height - line_height) * 0.5;
        let bounds = Bounds::new(
            point(outer_bounds.left(), line_top),
            size(outer_bounds.size.width, line_height),
        )
        .intersect(&outer_bounds);

        let entity = cx.entity();
        window.handle_input(
            &self.focus_handle,
            ElementInputHandler::new(bounds, entity.clone()),
            cx,
        );
        window.on_mouse_event({
            let entity = entity.clone();
            move |event: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble && entity.read(cx).is_selecting {
                    entity.update(cx, |input, cx| {
                        if !event.dragging() || !input.focus_handle.is_focused(window) {
                            input.is_selecting = false;
                            return;
                        }
                        let offset = input.index_for_mouse_position(event.position);
                        input.set_selection(input.anchor, offset, window, cx);
                    });
                }
            }
        });
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
            if phase == DispatchPhase::Capture
                && event.button == MouseButton::Left
                && entity.read(cx).is_selecting
            {
                entity.update(cx, |input, _| input.is_selecting = false);
            }
        });

        let is_empty = self.content.is_empty();
        let (display_text, text_color) = if is_empty {
            (self.placeholder.clone(), theme.muted_foreground)
        } else {
            (self.content.clone(), style.color)
        };
        let font = style.font();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let run = TextRun {
            len: display_text.len(),
            font: font.clone(),
            color: text_color,
            ..Default::default()
        };
        let mut marked_runs;
        let runs = if let Some(marked) = &self.marked_range {
            marked_runs = [run.clone(), run.clone(), run];
            let mut count = 0;
            for (length, underline) in [
                (marked.start, None),
                (
                    marked.end - marked.start,
                    Some(UnderlineStyle {
                        color: Some(text_color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                ),
                (display_text.len() - marked.end, None),
            ] {
                if length > 0 {
                    marked_runs[count].len = length;
                    marked_runs[count].underline = underline;
                    count += 1;
                }
            }
            &marked_runs[..count]
        } else {
            std::slice::from_ref(&run)
        };
        let line = window
            .text_system()
            .shape_line(display_text, font_size, runs, None);

        let cursor_x = if is_empty {
            px(0.0)
        } else {
            line.x_for_index(self.cursor)
        };
        self.scroll_offset_x = if is_empty {
            px(0.0)
        } else {
            scroll_offset_for(
                self.scroll_offset_x,
                line.width,
                cursor_x,
                bounds.size.width,
            )
        };

        let scroll = self.scroll_offset_x;
        let selected = self.selected_range();
        let is_focused = self.focus_handle.is_focused(window);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if is_focused && !selected.is_empty() {
                let start_x = line.x_for_index(selected.start) - scroll;
                let end_x = line.x_for_index(selected.end) - scroll;
                window.paint_quad(fill(
                    Bounds::from_corners(
                        point(bounds.left() + start_x, bounds.top()),
                        point(bounds.left() + end_x, bounds.bottom()),
                    ),
                    theme.primary.opacity(0.2),
                ));
            }

            let _ = line.paint(
                point(bounds.left() - scroll, line_top),
                line_height,
                TextAlign::Left,
                None,
                window,
                cx,
            );

            if is_focused && selected.is_empty() {
                window.paint_quad(fill(
                    Bounds::new(
                        point(bounds.left() + cursor_x - scroll, bounds.top()),
                        size(CARET_WIDTH, bounds.size.height),
                    ),
                    theme.foreground,
                ));
            }
        });

        self.last_layout = Some(line);
        self.last_bounds = Some(bounds);
        self.last_text_style = Some((font, font_size));
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
        let range = range_from_utf16(&self.content, &range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range()),
            reversed: self.cursor < self.anchor,
        })
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
        if self.marked_range.take().is_some() {
            window.notify_text_input_changed(&self.focus_handle);
            if self.focus_handle.is_focused(window) {
                window.invalidate_character_coordinates();
            }
            cx.notify();
        }
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = self.ime_target_range(range_utf16);
        self.apply_edit(range, new_text, None, window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = self.ime_target_range(range_utf16);
        self.apply_edit(range, new_text, Some(new_selected_range_utf16), window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (start_x, end_x) = if self.content.is_empty() {
            (px(0.0), px(0.0))
        } else {
            let (layout, scroll) = self.live_layout_and_scroll(bounds.size.width, window)?;
            let range = range_from_utf16(&self.content, &range_utf16);
            (
                layout.x_for_index(range.start) - scroll,
                layout.x_for_index(range.end) - scroll,
            )
        };
        Some(Bounds::from_corners(
            point(bounds.left() + start_x, bounds.top()),
            point(bounds.left() + end_x, bounds.bottom()),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let bounds = self.last_bounds?;
        let line_point = bounds.localize(&point)?;
        if self.content.is_empty() {
            return Some(0);
        }
        let (layout, scroll) = self.live_layout_and_scroll(bounds.size.width, window)?;
        let utf8_index = closest_grapheme_for_x(&self.content, &layout, line_point.x + scroll);
        Some(self.offset_to_utf16(utf8_index))
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let focused = self.focus_handle.is_focused(window);
        let background = if theme.dark {
            theme.input.opacity(0.3)
        } else {
            theme.background
        };
        let entity = cx.entity();

        let mut container = div()
            .id("text-input")
            .role(Role::TextInput)
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::on_action))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus_handle, cx);
                    let offset = this.index_for_mouse_position(event.position);
                    this.is_selecting = true;
                    let anchor = if event.modifiers.shift {
                        this.anchor
                    } else {
                        offset
                    };
                    this.set_selection(anchor, offset, window, cx);
                }),
            )
            .h(px(36.0))
            .w_full()
            .min_w_0()
            .rounded(theme.radius - px(2.0))
            .border_1()
            .border_color(if focused { theme.ring } else { theme.input })
            .bg(background)
            .px(px(12.0))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .text_color(theme.foreground);

        container.style().refine(&self.style);
        container.child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, cx| {
                    entity.update(cx, |input, cx| input.paint_line(bounds, window, cx));
                },
            )
            .size_full(),
        )
    }
}

fn scroll_offset_for(
    current: Pixels,
    line_width: Pixels,
    cursor_x: Pixels,
    bounds_width: Pixels,
) -> Pixels {
    let available = (bounds_width - CARET_WIDTH).max(px(0.0));
    if line_width <= available {
        return px(0.0);
    }
    current
        .max(cursor_x - available)
        .min(cursor_x)
        .clamp(px(0.0), line_width - available)
}

fn step_grapheme_boundary(text: &str, offset: usize, forward: bool) -> usize {
    let mut cursor = GraphemeCursor::new(offset, text.len(), true);
    let next = if forward {
        cursor.next_boundary(text, 0)
    } else {
        cursor.prev_boundary(text, 0)
    };
    next.ok().flatten().unwrap_or(offset)
}

fn snap_grapheme_boundary(text: &str, offset: usize, forward: bool) -> usize {
    if GraphemeCursor::new(offset, text.len(), true).is_boundary(text, 0) == Ok(true) {
        return offset;
    }
    step_grapheme_boundary(text, offset, forward)
}

fn closest_grapheme_for_x(text: &str, line: &LineLayout, x: Pixels) -> usize {
    let index = line.closest_index_for_x(x);
    let mut cursor = GraphemeCursor::new(index, text.len(), true);
    if cursor.is_boundary(text, 0) == Ok(true) {
        return index;
    }
    let prev = cursor.prev_boundary(text, 0).ok().flatten().unwrap_or(0);
    let next = step_grapheme_boundary(text, index, true);
    if (x - line.x_for_index(prev)).abs() < (line.x_for_index(next) - x).abs() {
        prev
    } else {
        next
    }
}

fn range_from_utf16(text: &str, range_utf16: &Range<usize>) -> Range<usize> {
    let start_target = range_utf16.start;
    let end_target = range_utf16.end.max(start_target);
    let mut utf8 = 0;
    let mut utf16 = 0;
    let mut start = None;

    for character in text.chars() {
        let next_utf16 = utf16 + character.len_utf16();
        if start.is_none() && next_utf16 > start_target {
            start = Some(utf8);
            if start_target == end_target {
                return utf8..utf8;
            }
        }
        if utf16 >= end_target {
            break;
        }
        utf8 += character.len_utf8();
        utf16 = next_utf16;
    }

    start.unwrap_or(utf8)..utf8
}

fn sanitize_single_line(text: &str) -> Cow<'_, str> {
    if !text
        .chars()
        .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
        return Cow::Borrowed(text);
    }

    let mut sanitized = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                characters.next_if_eq(&'\n');
                sanitized.push(' ');
            }
            '\n' | '\t' | '\u{2028}' | '\u{2029}' => sanitized.push(' '),
            other if other.is_control() => {}
            other => sanitized.push(other),
        }
    }
    Cow::Owned(sanitized)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use gpui::prelude::FluentBuilder;
    use gpui::{AppContext, Entity, Modifiers, TestAppContext, VisualTestContext};
    use rand::{Rng as _, rngs::StdRng};
    use unicode_segmentation::UnicodeSegmentation;

    const TEXT_AREA: Bounds<Pixels> = Bounds {
        origin: point(px(13.0), px(8.0)),
        size: size(px(174.0), px(20.0)),
    };

    struct TestHarness {
        cx: VisualTestContext,
        input: Entity<TextInput>,
        events: Rc<RefCell<Vec<TextInputEvent>>>,
    }

    impl TestHarness {
        fn new(cx: &mut TestAppContext) -> Self {
            Self::with_style(cx, |input| input.w(px(200.0)))
        }

        fn with_style(
            cx: &mut TestAppContext,
            configure: impl FnOnce(TextInput) -> TextInput + 'static,
        ) -> Self {
            cx.update(|cx| crate::init(cx).expect("init pandoks-gpui"));
            let events = Rc::new(RefCell::new(Vec::new()));
            let recorded = events.clone();

            let window = cx.add_window(|window, cx| {
                let input = configure(TextInput::new(window, cx).placeholder("Type here..."));
                input.focus(window, cx);
                let entity = cx.entity();
                cx.subscribe(&entity, move |_, _, event, _| {
                    recorded.borrow_mut().push(event.clone());
                })
                .detach();
                input
            });

            let mut cx = VisualTestContext::from_window(window.into(), cx);
            let input = window.root(&mut cx).expect("root entity");
            cx.update(|window, _| window.activate_window());
            cx.run_until_parked();
            Self { cx, input, events }
        }

        fn value(&self) -> String {
            self.input
                .read_with(&self.cx, |input, _| input.value().to_owned())
        }

        fn set_value(&mut self, value: &str) {
            self.update_input(|input, window, cx| input.set_value(value, window, cx));
            self.cx.run_until_parked();
        }

        fn selected(&mut self) -> (Range<usize>, bool) {
            self.update_input(|input, window, cx| {
                let selection = input
                    .selected_text_range(false, window, cx)
                    .expect("selected range");
                (selection.range, selection.reversed)
            })
        }

        fn marked_range(&mut self) -> Option<Range<usize>> {
            self.update_input(|input, window, cx| input.marked_text_range(window, cx))
        }

        fn set_clipboard(&self, text: &str) {
            self.cx
                .write_to_clipboard(ClipboardItem::new_string(text.to_owned()));
        }

        fn clipboard_text(&self) -> Option<String> {
            self.cx.read_from_clipboard().and_then(|item| item.text())
        }

        fn take_events(&self) -> Vec<TextInputEvent> {
            std::mem::take(&mut *self.events.borrow_mut())
        }

        fn update_input<R>(
            &mut self,
            action: impl FnOnce(&mut TextInput, &mut Window, &mut Context<TextInput>) -> R,
        ) -> R {
            self.cx
                .update(|window, cx| self.input.update(cx, |input, cx| action(input, window, cx)))
        }
    }

    fn utf8_from_utf16_exact(text: &str, target_utf16: usize) -> usize {
        let (mut utf8, mut utf16) = (0, 0);
        for character in text.chars() {
            if utf16 == target_utf16 {
                return utf8;
            }
            utf16 += character.len_utf16();
            utf8 += character.len_utf8();
            assert!(
                utf16 <= target_utf16,
                "UTF-16 offset {target_utf16} inside surrogate pair in {text:?}"
            );
        }
        assert_eq!(utf16, target_utf16, "UTF-16 offset out of bounds");
        utf8
    }

    fn assert_grapheme_boundary(text: &str, offset: usize) {
        let is_boundary = offset == text.len()
            || text
                .grapheme_indices(true)
                .any(|(boundary, _)| boundary == offset);
        assert!(is_boundary, "offset {offset} mid-grapheme in {text:?}");
    }

    #[gpui::test]
    fn typing_movement_selection_deletion_and_events(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);

        harness.cx.simulate_input("a😀e\u{0301}b");
        assert_eq!(harness.value(), "a😀e\u{0301}b");
        assert_eq!(
            harness.take_events(),
            ["a", "a😀", "a😀e", "a😀e\u{0301}", "a😀e\u{0301}b"]
                .map(|text| TextInputEvent::Change(text.into()))
        );

        harness.cx.simulate_keystrokes("left backspace");
        assert_eq!(harness.value(), "a😀b");
        assert_eq!(
            harness.take_events(),
            [TextInputEvent::Change("a😀b".into())]
        );

        harness.cx.simulate_keystrokes("home delete delete");
        assert_eq!(harness.value(), "b");

        harness.cx.simulate_keystrokes("end");
        harness.cx.simulate_input("e\u{0301}😀");
        harness.cx.simulate_keystrokes("shift-left");
        assert_eq!(harness.selected(), (3..5, true));
        harness.cx.simulate_input("!");
        assert_eq!(harness.value(), "be\u{0301}!");

        harness.cx.simulate_keystrokes("left delete");
        assert_eq!(harness.value(), "be\u{0301}");

        harness.cx.simulate_keystrokes("home shift-right right");
        harness.cx.simulate_input("?");
        assert_eq!(harness.value(), "b?e\u{0301}");

        harness
            .cx
            .simulate_keystrokes("home shift-right shift-right left");
        harness.cx.simulate_input("^");
        harness.cx.simulate_keystrokes("right");
        harness.cx.simulate_input("*");
        assert_eq!(harness.value(), "^b*?e\u{0301}");

        #[cfg(target_os = "macos")]
        {
            harness.cx.simulate_keystrokes("cmd-left");
            harness.cx.simulate_input("[");
            harness.cx.simulate_keystrokes("cmd-right");
            harness.cx.simulate_input("]");
            assert_eq!(harness.value(), "[^b*?e\u{0301}]");
        }

        let expected_submit = harness.value();
        harness.take_events();
        harness.cx.simulate_keystrokes("enter");
        assert_eq!(
            harness.take_events(),
            [TextInputEvent::Submit(expected_submit.into())]
        );

        harness.set_value("hello\nworld\t\x07\u{2028}!");
        assert_eq!(harness.value(), "hello world  !");
        assert_eq!(
            harness.take_events(),
            [TextInputEvent::Change("hello world  !".into())]
        );

        harness.set_value("hello world  !");
        assert!(harness.take_events().is_empty());

        harness.update_input(|input, window, cx| input.clear(window, cx));
        harness.cx.run_until_parked();
        assert_eq!(harness.value(), "");
        assert_eq!(harness.take_events(), [TextInputEvent::Change("".into())]);

        harness.update_input(|input, window, cx| input.clear(window, cx));
        harness.cx.run_until_parked();
        assert!(harness.take_events().is_empty());
    }

    #[gpui::test]
    fn clipboard_sanitizing_and_mouse(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);
        let left = MouseButton::Left;
        let none = Modifiers::none();
        let at = |x, y| point(px(x), px(y));

        harness.cx.simulate_keystrokes("secondary-v");
        assert_eq!(harness.value(), "");

        harness.cx.simulate_input("hello\nworld");
        assert_eq!(harness.value(), "hello world");

        harness.set_clipboard("keep");
        harness.cx.simulate_keystrokes("secondary-c secondary-x");
        assert_eq!(harness.clipboard_text().as_deref(), Some("keep"));
        assert_eq!(harness.value(), "hello world");

        harness.cx.simulate_keystrokes("secondary-a secondary-c");
        assert_eq!(harness.clipboard_text().as_deref(), Some("hello world"));

        harness.set_clipboard("stale");
        harness.cx.simulate_keystrokes("secondary-x");
        assert_eq!(harness.value(), "");
        assert_eq!(harness.clipboard_text().as_deref(), Some("hello world"));

        harness.set_clipboard("a\r\nb\tc\u{2028}d\u{2029}e\x07f\ng");
        harness.cx.simulate_keystrokes("secondary-v");
        assert_eq!(harness.value(), "a b c d ef g");

        harness.set_value("ac");
        harness.cx.simulate_keystrokes("left");
        harness.set_clipboard("b");
        harness.cx.simulate_keystrokes("secondary-v");
        assert_eq!(harness.value(), "abc");

        harness.cx.simulate_keystrokes("shift-left");
        harness.set_clipboard("XY");
        harness.cx.simulate_keystrokes("secondary-v");
        assert_eq!(harness.value(), "aXYc");

        harness.set_value("abcdef");
        harness.cx.simulate_click(at(30.0, 2.0), none);
        harness.cx.simulate_input("X");
        let after_top_click = harness.value();
        assert!(
            after_top_click.contains('X')
                && !after_top_click.starts_with('X')
                && !after_top_click.ends_with('X'),
            "expected click in top padding inside text, got {after_top_click:?}"
        );

        harness.set_value("abcdef");
        harness.cx.simulate_mouse_down(at(14.0, 18.0), left, none);
        harness.cx.simulate_mouse_move(at(350.0, 18.0), left, none);
        harness.cx.simulate_mouse_up(at(350.0, 18.0), left, none);
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "");

        harness.set_value("abcdef");
        harness.cx.simulate_mouse_down(at(14.0, 18.0), left, none);
        harness.cx.simulate_mouse_up(at(14.0, 18.0), left, none);
        harness.cx.simulate_mouse_move(at(350.0, 18.0), left, none);
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "abcdef");

        harness.set_value("abcdef");
        harness.cx.simulate_mouse_down(at(14.0, 18.0), left, none);
        harness.cx.simulate_mouse_move(at(350.0, 18.0), None, none);
        harness.cx.simulate_mouse_move(at(350.0, 18.0), left, none);
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "abcdef");

        harness.set_value("abcdef");
        harness.cx.simulate_click(at(14.0, 18.0), none);
        harness
            .cx
            .simulate_click(at(190.0, 18.0), Modifiers::shift());
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "");

        harness.set_value("e\u{0301}b");
        let (left_of_mid, between_base_and_mark) = harness.update_input(|input, window, cx| {
            let base = input
                .bounds_for_range(0..1, TEXT_AREA, window, cx)
                .expect("base bounds");
            let left_of_mid = point(base.left() + base.size.width * 0.8, TEXT_AREA.center().y);
            let boundary = point(base.right(), TEXT_AREA.center().y);
            assert_eq!(
                input.character_index_for_point(left_of_mid, window, cx),
                Some(0)
            );
            assert_eq!(
                input.character_index_for_point(boundary, window, cx),
                Some(2)
            );
            (left_of_mid, boundary)
        });
        harness.cx.simulate_click(left_of_mid, none);
        assert_eq!(harness.selected(), (0..0, false));
        harness.cx.simulate_click(between_base_and_mark, none);
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "b");

        harness.set_value(&"a".repeat(40));
        let left_edge = point(TEXT_AREA.left() + px(1.0), TEXT_AREA.center().y);
        harness.update_input(|input, window, cx| {
            let caret = input
                .bounds_for_range(40..40, TEXT_AREA, window, cx)
                .expect("scrolled caret");
            assert!(caret.left() <= TEXT_AREA.right());
            assert!(input.character_index_for_point(left_edge, window, cx) > Some(10));
        });
        harness.cx.simulate_click(left_edge, none);
        harness.cx.simulate_input("!");
        assert!(harness.value().find('!').expect("inserted") > 10);

        harness.set_value("aaaaaaaaaa");
        harness.cx.update(|window, cx| {
            harness
                .input
                .update(cx, |input, cx| input.set_value("😀", window, cx));
            window.dispatch_event(
                gpui::PlatformInput::MouseDown(MouseDownEvent {
                    position: at(28.0, 18.0),
                    modifiers: none,
                    button: left,
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
        });
        harness.cx.simulate_input("!");
        assert_eq!(harness.value(), "😀!");

        let mut short = TestHarness::with_style(cx, |input| input.w(px(200.0)).h(px(12.0)));
        short.set_value("abcdef");
        short.update_input(|input, window, cx| {
            assert_eq!(
                input.character_index_for_point(at(20.0, 14.0), window, cx),
                None
            );
            assert!(
                input
                    .character_index_for_point(at(20.0, 6.0), window, cx)
                    .is_some()
            );
        });

        struct TwoInputs {
            first: Entity<TextInput>,
            second: Entity<TextInput>,
            show_first: bool,
        }
        impl Render for TwoInputs {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
                    .w(px(200.0))
                    .when(self.show_first, |box_div| box_div.child(self.first.clone()))
                    .child(self.second.clone())
            }
        }

        let two_window = cx.add_window(|window, cx| TwoInputs {
            first: cx.new(|cx| TextInput::new(window, cx)),
            second: cx.new(|cx| TextInput::new(window, cx)),
            show_first: true,
        });
        let mut two_cx = VisualTestContext::from_window(two_window.into(), cx);
        let root = two_window.root(&mut two_cx).expect("root");
        let (first, second) =
            root.read_with(&two_cx, |view, _| (view.first.clone(), view.second.clone()));
        two_cx.update(|window, cx| {
            window.activate_window();
            first.update(cx, |input, cx| input.set_value("abcdef", window, cx));
            second.update(cx, |input, cx| input.set_value("abcdef", window, cx));
        });
        two_cx.run_until_parked();

        two_cx.simulate_mouse_down(at(14.0, 18.0), left, none);
        two_cx.simulate_mouse_up(at(14.0, 18.0), MouseButton::Right, none);
        two_cx.simulate_mouse_down(at(14.0, 54.0), left, none);
        two_cx.simulate_mouse_move(at(350.0, 54.0), left, none);
        two_cx.simulate_mouse_up(at(350.0, 54.0), left, none);
        two_cx.update(|window, cx| {
            let first_sel =
                first.update(cx, |input, cx| input.selected_text_range(false, window, cx));
            let second_sel =
                second.update(cx, |input, cx| input.selected_text_range(false, window, cx));
            assert!(first_sel.expect("first").range.is_empty());
            assert_eq!(second_sel.expect("second").range, 0..6);
            first.update(cx, |input, cx| {
                input.focus(window, cx);
                input.replace_and_mark_text_in_range(None, "ni", None, window, cx);
            });
        });
        two_cx.run_until_parked();
        root.update(&mut two_cx, |view, cx| {
            view.show_first = false;
            cx.notify();
        });
        two_cx.run_until_parked();
        assert_eq!(
            two_cx.update(
                |window, cx| first.update(cx, |input, cx| input.marked_text_range(window, cx))
            ),
            None
        );
    }

    #[gpui::test]
    fn ime_composition_and_utf16(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);

        harness.update_input(|input, window, cx| {
            assert_eq!(
                input.bounds_for_range(0..0, TEXT_AREA, window, cx),
                Some(Bounds::new(
                    TEXT_AREA.origin,
                    size(px(0.0), TEXT_AREA.size.height)
                ))
            );
            assert_eq!(
                input.character_index_for_point(TEXT_AREA.center(), window, cx),
                Some(0)
            );
        });

        harness.cx.simulate_input("a😀b");
        harness.cx.run_until_parked();

        harness.update_input(|input, window, cx| {
            for (requested, expected_text, expected_adjusted) in [
                (4..4, "", 4..4),
                (2..2, "", 1..1),
                (2..3, "😀", 1..3),
                (1..2, "😀", 1..3),
            ] {
                let mut adjusted = None;
                assert_eq!(
                    input
                        .text_for_range(requested, &mut adjusted, window, cx)
                        .as_deref(),
                    Some(expected_text)
                );
                assert_eq!(adjusted, Some(expected_adjusted));
            }

            let emoji_bounds = input
                .bounds_for_range(1..3, TEXT_AREA, window, cx)
                .expect("emoji bounds");
            assert!(emoji_bounds.size.width > px(0.0));
            assert_eq!(
                input.character_index_for_point(
                    point(emoji_bounds.right(), emoji_bounds.center().y),
                    window,
                    cx,
                ),
                Some(3)
            );

            input.replace_text_in_range(Some(2..2), "X", window, cx);
            assert_eq!(input.value(), "aX😀b");

            input.replace_text_in_range(Some(2..4), "Y", window, cx);
            assert_eq!(input.value(), "aXYb");

            input.replace_and_mark_text_in_range(None, "😀x", Some(0..2), window, cx);
            assert_eq!(input.marked_text_range(window, cx), Some(3..6));
            let marked_bounds = input
                .bounds_for_range(3..6, TEXT_AREA, window, cx)
                .expect("bounds immediately after composition starts");
            assert!(marked_bounds.size.width > px(0.0));
        });
        assert_eq!(harness.selected(), (3..5, false));

        harness.cx.simulate_keystrokes("secondary-a");
        assert_eq!(harness.marked_range(), None);
        harness.cx.simulate_keystrokes("secondary-x");
        assert_eq!(harness.value(), "");
        assert_eq!(harness.clipboard_text().as_deref(), Some("aXY😀xb"));

        harness.update_input(|input, window, cx| {
            input.replace_and_mark_text_in_range(None, "ni", None, window, cx);
            input.replace_and_mark_text_in_range(None, "nihao", None, window, cx);
            assert_eq!(input.value(), "nihao");
            assert_eq!(input.marked_text_range(window, cx), Some(0..5));

            input.unmark_text(window, cx);
            assert_eq!(input.value(), "nihao");
            assert_eq!(input.marked_text_range(window, cx), None);

            input.replace_and_mark_text_in_range(None, "ha", None, window, cx);
            input.replace_text_in_range(None, "你", window, cx);
            assert_eq!(input.value(), "nihao你");
            assert_eq!(input.marked_text_range(window, cx), None);

            input.replace_and_mark_text_in_range(None, "ma", None, window, cx);
            assert_eq!(input.marked_text_range(window, cx), Some(6..8));
            window.blur(cx);
        });
        harness.cx.run_until_parked();
        assert_eq!(harness.marked_range(), None);

        harness.update_input(|input, window, cx| {
            input.focus(window, cx);
            input.replace_and_mark_text_in_range(None, "de", None, window, cx);
        });
        harness.cx.run_until_parked();
        assert!(harness.marked_range().is_some());
        harness.cx.deactivate_window();
        assert_eq!(harness.marked_range(), None);
    }

    #[gpui::test(iterations = 100)]
    fn randomized_editing_invariants(mut rng: StdRng, cx: &mut TestAppContext) {
        const ALPHABET: &[&str] = &[
            "a",
            "b",
            "😀",
            "e\u{0301}",
            "\u{0301}",
            "👩\u{200d}👧",
            "\n",
            "\t",
            "\r\n",
            "\u{2028}",
        ];
        const KEYSTROKES: &[&str] = &[
            "backspace",
            "delete",
            "left",
            "right",
            "shift-left",
            "shift-right",
            "home",
            "end",
            "enter",
            #[cfg(target_os = "macos")]
            "cmd-left",
            #[cfg(target_os = "macos")]
            "cmd-right",
            "secondary-a",
            "secondary-c",
            "secondary-x",
            "secondary-v",
        ];

        let random_text = |rng: &mut StdRng, max_pieces: usize| -> String {
            (0..rng.random_range(0..=max_pieces))
                .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())])
                .collect()
        };
        let random_range = |rng: &mut StdRng, utf16_len: usize| {
            let max = utf16_len + 2;
            rng.random_range(0..=max)..rng.random_range(0..=max)
        };

        let mut harness = TestHarness::new(cx);
        harness.take_events();

        for step in 0..80 {
            let prev_value = harness.value();
            let mut single_op = true;

            match rng.random_range(0..10) {
                0..=1 => {
                    let piece = ALPHABET[rng.random_range(0..ALPHABET.len())];
                    single_op = piece.chars().count() <= 1;
                    harness.cx.simulate_input(piece);
                }
                2..=3 => {
                    harness
                        .cx
                        .simulate_keystrokes(KEYSTROKES[rng.random_range(0..KEYSTROKES.len())]);
                }
                4 => {
                    let pos = point(
                        px(rng.random_range(-20.0..=240.0)),
                        px(rng.random_range(-10.0..=50.0)),
                    );
                    let mods = if rng.random_bool(0.3) {
                        Modifiers::shift()
                    } else {
                        Modifiers::none()
                    };
                    match rng.random_range(0..3) {
                        0 => harness.cx.simulate_mouse_down(pos, MouseButton::Left, mods),
                        1 => harness.cx.simulate_mouse_move(
                            pos,
                            rng.random_bool(0.7).then_some(MouseButton::Left),
                            mods,
                        ),
                        _ => harness.cx.simulate_mouse_up(
                            pos,
                            if rng.random_bool(0.8) {
                                MouseButton::Left
                            } else {
                                MouseButton::Right
                            },
                            mods,
                        ),
                    }
                }
                5 => {
                    harness.set_clipboard(&random_text(&mut rng, 4));
                    harness.cx.simulate_keystrokes("secondary-v");
                }
                6 => {
                    let text = random_text(&mut rng, 5);
                    harness.update_input(|input, window, cx| {
                        input.set_value(text, window, cx);
                        let selection = input
                            .selected_text_range(false, window, cx)
                            .expect("selection");
                        assert!(
                            input
                                .bounds_for_range(selection.range, TEXT_AREA, window, cx)
                                .is_some()
                        );
                    });
                }
                7 | 8 => {
                    let is_mark = rng.random_bool(0.5);
                    let range = rng
                        .random_bool(0.5)
                        .then(|| random_range(&mut rng, prev_value.encode_utf16().count()));
                    let text = random_text(&mut rng, 3);
                    let selection = is_mark
                        .then(|| {
                            rng.random_bool(0.5)
                                .then(|| random_range(&mut rng, text.encode_utf16().count()))
                        })
                        .flatten();
                    harness.update_input(|input, window, cx| {
                        if is_mark {
                            input.replace_and_mark_text_in_range(
                                range, &text, selection, window, cx,
                            );
                        } else {
                            input.replace_text_in_range(range, &text, window, cx);
                        }
                        let selection = input
                            .selected_text_range(false, window, cx)
                            .expect("selection");
                        assert!(
                            input
                                .bounds_for_range(selection.range, TEXT_AREA, window, cx)
                                .is_some()
                        );
                    });
                }
                _ => harness.update_input(|input, window, cx| input.unmark_text(window, cx)),
            }

            let value = harness.value();
            assert!(
                !value.chars().any(|character| character.is_control()
                    || matches!(character, '\u{2028}' | '\u{2029}')),
                "step {step}: unsanitized {value:?}"
            );

            let changes: Vec<String> = harness
                .take_events()
                .into_iter()
                .filter_map(|event| match event {
                    TextInputEvent::Change(text) => Some(text.to_string()),
                    TextInputEvent::Submit(_) => None,
                })
                .collect();
            if single_op {
                let expected = (value != prev_value).then_some(value.as_str());
                assert_eq!(
                    changes.iter().map(String::as_str).collect::<Vec<_>>(),
                    expected.into_iter().collect::<Vec<_>>(),
                    "step {step}: Change mismatch for {prev_value:?} -> {value:?}"
                );
            } else {
                let mut running = prev_value.as_str();
                for next in &changes {
                    assert_ne!(next, running, "step {step}: duplicate Change {next:?}");
                    running = next;
                }
                assert_eq!(running, value, "step {step}: final Change mismatch");
            }

            let probe = point(
                px(rng.random_range(TEXT_AREA.left().as_f32()..=TEXT_AREA.right().as_f32())),
                TEXT_AREA.center().y,
            );
            harness.update_input(|input, window, cx| {
                let selection = input
                    .selected_text_range(false, window, cx)
                    .expect("selection");
                let sel_start = utf8_from_utf16_exact(&value, selection.range.start);
                let sel_end = utf8_from_utf16_exact(&value, selection.range.end);
                assert!(sel_start <= sel_end);
                assert_grapheme_boundary(&value, sel_start);
                assert_grapheme_boundary(&value, sel_end);

                let mut actual = None;
                assert_eq!(
                    input.text_for_range(selection.range.clone(), &mut actual, window, cx),
                    Some(value[sel_start..sel_end].to_owned())
                );
                assert_eq!(actual, Some(selection.range.clone()));

                let caret = if selection.reversed {
                    selection.range.start
                } else {
                    selection.range.end
                };
                assert!(
                    input
                        .bounds_for_range(caret..caret, TEXT_AREA, window, cx)
                        .is_some()
                );

                if let Some(marked) = input.marked_text_range(window, cx) {
                    let mark_start = utf8_from_utf16_exact(&value, marked.start);
                    let mark_end = utf8_from_utf16_exact(&value, marked.end);
                    assert!(mark_start < mark_end);
                    assert_grapheme_boundary(&value, mark_start);
                    assert_grapheme_boundary(&value, mark_end);
                }

                if let Some(hit_utf16) = input.character_index_for_point(probe, window, cx) {
                    assert_grapheme_boundary(&value, utf8_from_utf16_exact(&value, hit_utf16));
                }
            });
        }
    }
}
