use std::borrow::Cow;
use std::ops::Range;

use gpui::{
    Action, App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, DispatchPhase,
    ElementInputHandler, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, KeyBinding, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Pixels, Point, Refineable, Render, Role, ShapedLine, SharedString,
    StatefulInteractiveElement, StyleRefinement, Styled, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, Window, canvas, div, fill, point, px, size,
};
use unicode_segmentation::UnicodeSegmentation;

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
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: SharedString::default(),
            placeholder: SharedString::default(),
            anchor: 0,
            cursor: 0,
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
        let value = value.into();
        let next = match sanitize_single_line(&value) {
            Cow::Borrowed(_) => value,
            Cow::Owned(clean) => clean.into(),
        };
        let changed = self.content != next;
        let length = next.len();
        if !changed && self.marked_range.is_none() && self.anchor == length && self.cursor == length
        {
            return;
        }
        self.content = next;
        self.anchor = length;
        self.cursor = length;
        self.marked_range = None;
        self.scroll_offset_x = px(0.0);
        window.notify_text_input_changed(&self.focus_handle);
        if changed {
            cx.emit(TextInputEvent::Change(self.content.clone()));
        }
        cx.notify();
    }

    pub fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_value("", window, cx);
    }

    fn selected_range(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }

    fn set_selection(
        &mut self,
        anchor: usize,
        cursor: usize,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let length = self.content.len();
        self.anchor = anchor.min(length);
        self.cursor = cursor.min(length);
        if self.marked_range.take().is_some() {
            window.notify_text_input_changed(&self.focus_handle);
        }
        window.notify_text_selection_changed(&self.focus_handle);
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
            self.step_boundary(self.cursor, forward)
        } else if forward {
            range.end
        } else {
            range.start
        };
        let anchor = if select { self.anchor } else { next };
        self.set_selection(anchor, next, window, cx);
    }

    fn delete_direction(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let unmarked = self.marked_range.take().is_some();
        if self.anchor == self.cursor {
            let target = self.step_boundary(self.cursor, forward);
            if target == self.cursor {
                if unmarked {
                    window.notify_text_input_changed(&self.focus_handle);
                    cx.notify();
                }
                return;
            }
            self.cursor = target;
        }
        self.apply_edit(self.selected_range(), "", None, window, cx);
    }

    fn copy_selection(&self, cx: &mut Context<Self>) -> bool {
        let range = self.selected_range();
        if range.is_empty() {
            return false;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(self.content[range].to_owned()));
        true
    }

    fn step_boundary(&self, offset: usize, forward: bool) -> usize {
        if forward {
            self.content
                .grapheme_indices(true)
                .find_map(|(index, _)| (index > offset).then_some(index))
                .unwrap_or(self.content.len())
        } else {
            self.content
                .grapheme_indices(true)
                .rev()
                .find_map(|(index, _)| (index < offset).then_some(index))
                .unwrap_or(0)
        }
    }

    fn valid_layout(&self) -> Option<&ShapedLine> {
        self.last_layout
            .as_ref()
            .filter(|layout| layout.text == self.content)
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.valid_layout()) else {
            return self.cursor;
        };
        line.closest_index_for_x(position.x - bounds.left() + self.scroll_offset_x)
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
        window: &mut Window,
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
        match mark_selection {
            Some(selection) => {
                self.marked_range = (!sanitized.is_empty()).then_some(range.start..end);
                (self.anchor, self.cursor) = match selection {
                    Some(selection) => {
                        let selected = range_from_utf16(&sanitized, &selection);
                        (range.start + selected.start, range.start + selected.end)
                    }
                    None => (end, end),
                };
            }
            None => {
                self.marked_range = None;
                self.anchor = end;
                self.cursor = end;
            }
        }

        window.notify_text_input_changed(&self.focus_handle);
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
        let bounds = Bounds::new(
            point(
                outer_bounds.left(),
                outer_bounds.top() + (outer_bounds.size.height - line_height) * 0.5,
            ),
            size(outer_bounds.size.width, line_height),
        );

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
                        if !event.dragging() {
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
        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            ..Default::default()
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = if let Some(marked) = &self.marked_range {
            let runs: Vec<_> = [
                (marked.start, None),
                (
                    marked.end - marked.start,
                    Some(UnderlineStyle {
                        color: Some(text_color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                ),
                (display_text.len().saturating_sub(marked.end), None),
            ]
            .into_iter()
            .filter(|(length, _)| *length > 0)
            .map(|(length, underline)| TextRun {
                len: length,
                underline,
                ..run.clone()
            })
            .collect();
            window
                .text_system()
                .shape_line(display_text, font_size, &runs, None)
        } else {
            window
                .text_system()
                .shape_line(display_text, font_size, &[run], None)
        };

        let cursor_x = if is_empty {
            px(0.0)
        } else {
            line.x_for_index(self.cursor)
        };
        let available = (bounds.size.width - CARET_WIDTH).max(px(0.0));
        self.scroll_offset_x = if is_empty || line.width <= available {
            px(0.0)
        } else {
            let max_scroll = line.width - available;
            self.scroll_offset_x
                .max(cursor_x - available)
                .min(cursor_x)
                .clamp(px(0.0), max_scroll)
        };

        let scroll = self.scroll_offset_x;
        let selected = self.selected_range();
        let is_focused = self.focus_handle.is_focused(window);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if is_focused && !is_empty && !selected.is_empty() {
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
                point(bounds.left() - scroll, bounds.top()),
                line_height,
                TextAlign::Left,
                None,
                window,
                cx,
            );

            if is_focused && (is_empty || selected.is_empty()) {
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
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (start_x, end_x) = if self.content.is_empty() {
            (px(0.0), px(0.0))
        } else {
            let line = self.valid_layout()?;
            let range = range_from_utf16(&self.content, &range_utf16);
            (
                line.x_for_index(range.start) - self.scroll_offset_x,
                line.x_for_index(range.end) - self.scroll_offset_x,
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
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let line_point = self.last_bounds?.localize(&point)?;
        if self.content.is_empty() {
            return Some(0);
        }
        let utf8_index = self
            .valid_layout()?
            .closest_index_for_x(line_point.x + self.scroll_offset_x);
        Some(self.offset_to_utf16(utf8_index))
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let focused = self.focus_handle.is_focused(window);
        if !focused {
            self.marked_range = None;
        }
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
            .flex()
            .items_center()
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
    use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

    struct TestHarness {
        cx: VisualTestContext,
        input: Entity<TextInput>,
        events: Rc<RefCell<Vec<TextInputEvent>>>,
    }

    impl TestHarness {
        fn new(cx: &mut TestAppContext) -> Self {
            cx.update(|cx| crate::init(cx).expect("init pandoks-gpui"));
            let events = Rc::new(RefCell::new(Vec::new()));
            let recorded = events.clone();

            let window = cx.add_window(|window, cx| {
                let input = TextInput::new(cx).placeholder("Type here...").w(px(200.0));
                input.focus(window, cx);
                let entity = cx.entity();
                cx.subscribe(&entity, move |_, _, event, _| {
                    recorded.borrow_mut().push(event.clone());
                })
                .detach();
                input
            });

            let mut visual_cx = VisualTestContext::from_window(window.into(), cx);
            let input = window.root(&mut visual_cx).expect("root entity");
            visual_cx.run_until_parked();
            Self {
                cx: visual_cx,
                input,
                events,
            }
        }

        fn value(&self) -> String {
            self.input
                .read_with(&self.cx, |input, _| input.value().to_owned())
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

    #[gpui::test]
    fn typing_movement_selection_deletion_and_events(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);

        harness.cx.simulate_input("a😀e\u{0301}b");
        assert_eq!(harness.value(), "a😀e\u{0301}b");
        assert_eq!(
            harness.take_events(),
            vec![
                TextInputEvent::Change("a".into()),
                TextInputEvent::Change("a😀".into()),
                TextInputEvent::Change("a😀e".into()),
                TextInputEvent::Change("a😀e\u{0301}".into()),
                TextInputEvent::Change("a😀e\u{0301}b".into()),
            ]
        );

        harness.cx.simulate_keystrokes("left backspace");
        assert_eq!(harness.value(), "a😀b");
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Change("a😀b".into())]
        );

        harness.cx.simulate_keystrokes("home delete delete");
        assert_eq!(harness.value(), "b");

        harness.cx.simulate_keystrokes("end");
        harness.cx.simulate_input("e\u{0301}😀");
        harness
            .cx
            .simulate_keystrokes("shift-left shift-left shift-right left");
        harness.cx.simulate_input("!");
        assert_eq!(harness.value(), "be\u{0301}!😀");

        harness.cx.simulate_keystrokes("home shift-right right");
        harness.cx.simulate_input("?");
        assert_eq!(harness.value(), "b?e\u{0301}!😀");

        #[cfg(target_os = "macos")]
        {
            harness.cx.simulate_keystrokes("cmd-left");
            harness.cx.simulate_input("[");
            harness.cx.simulate_keystrokes("cmd-right");
            harness.cx.simulate_input("]");
            assert_eq!(harness.value(), "[b?e\u{0301}!😀]");
        }

        let expected_submit = harness.value();
        harness.take_events();
        harness.cx.simulate_keystrokes("enter");
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Submit(expected_submit.into())]
        );

        harness.update_input(|input, window, cx| input.set_value("hello", window, cx));
        harness.cx.run_until_parked();
        assert_eq!(harness.value(), "hello");
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Change("hello".into())]
        );

        harness.update_input(|input, window, cx| input.set_value("hello", window, cx));
        harness.cx.run_until_parked();
        assert!(harness.take_events().is_empty());

        harness.update_input(|input, window, cx| input.clear(window, cx));
        harness.cx.run_until_parked();
        assert_eq!(harness.value(), "");
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Change("".into())]
        );

        harness.update_input(|input, window, cx| input.clear(window, cx));
        harness.cx.run_until_parked();
        assert!(harness.take_events().is_empty());
    }

    #[gpui::test]
    fn clipboard_sanitizing_and_mouse(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);

        harness.cx.simulate_input("hello world");
        harness.cx.simulate_keystrokes("secondary-a secondary-c");
        assert_eq!(harness.clipboard_text().as_deref(), Some("hello world"));

        harness
            .cx
            .write_to_clipboard(ClipboardItem::new_string("stale".to_owned()));
        harness.take_events();
        harness.cx.simulate_keystrokes("secondary-x");
        assert_eq!(harness.value(), "");
        assert_eq!(harness.clipboard_text().as_deref(), Some("hello world"));
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Change("".into())]
        );

        harness.cx.write_to_clipboard(ClipboardItem::new_string(
            "a\r\nb\tc\u{2028}d\u{2029}e\x07f\ng".to_owned(),
        ));
        harness.cx.simulate_keystrokes("secondary-v");
        assert_eq!(harness.value(), "a b c d ef g");
        assert_eq!(
            harness.take_events(),
            vec![TextInputEvent::Change("a b c d ef g".into())]
        );

        harness.update_input(|input, window, cx| input.set_value("abcdef", window, cx));
        harness.cx.run_until_parked();

        harness
            .cx
            .simulate_click(point(px(30.0), px(2.0)), Modifiers::none());
        harness.cx.simulate_input("X");
        let after_top_click = harness.value();
        assert!(
            after_top_click.contains('X')
                && !after_top_click.starts_with('X')
                && !after_top_click.ends_with('X'),
            "expected click in top padding to place caret inside text, got {after_top_click:?}"
        );

        harness.update_input(|input, window, cx| input.set_value("abcdef", window, cx));
        harness.cx.run_until_parked();
        harness.cx.simulate_mouse_down(
            point(px(14.0), px(18.0)),
            MouseButton::Left,
            Modifiers::none(),
        );
        harness.cx.simulate_mouse_move(
            point(px(350.0), px(18.0)),
            MouseButton::Left,
            Modifiers::none(),
        );
        harness.cx.simulate_mouse_up(
            point(px(350.0), px(18.0)),
            MouseButton::Left,
            Modifiers::none(),
        );
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "");

        harness.update_input(|input, window, cx| input.set_value("abcdef", window, cx));
        harness.cx.run_until_parked();
        harness.cx.simulate_mouse_down(
            point(px(14.0), px(18.0)),
            MouseButton::Left,
            Modifiers::none(),
        );
        harness
            .cx
            .simulate_mouse_move(point(px(350.0), px(18.0)), None, Modifiers::none());
        harness.cx.simulate_keystrokes("backspace");
        assert_eq!(harness.value(), "abcdef");

        harness.update_input(|input, window, cx| input.set_value("aaaaaaaaaa", window, cx));
        harness.cx.run_until_parked();
        harness.cx.update(|window, cx| {
            harness
                .input
                .update(cx, |input, cx| input.set_value("😀", window, cx));
            window.dispatch_event(
                gpui::PlatformInput::MouseDown(MouseDownEvent {
                    position: point(px(28.0), px(18.0)),
                    modifiers: Modifiers::none(),
                    button: MouseButton::Left,
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
        });
        harness.cx.simulate_mouse_up(
            point(px(28.0), px(18.0)),
            MouseButton::Left,
            Modifiers::none(),
        );
        harness.cx.simulate_input("!");
        assert_eq!(harness.value(), "😀!");
    }

    #[gpui::test]
    fn ime_composition_and_utf16(cx: &mut TestAppContext) {
        let mut harness = TestHarness::new(cx);
        let text_area = Bounds::new(point(px(13.0), px(8.0)), size(px(174.0), px(20.0)));

        harness.update_input(|input, window, cx| {
            let caret = input
                .bounds_for_range(0..0, text_area, window, cx)
                .expect("empty field caret bounds");
            assert_eq!(caret.left(), text_area.left());
            assert_eq!(caret.top(), text_area.top());
            assert_eq!(caret.bottom(), text_area.bottom());
            assert_eq!(
                input.character_index_for_point(text_area.center(), window, cx),
                Some(0)
            );
        });

        harness.cx.simulate_input("a😀b");
        harness.cx.run_until_parked();

        harness.update_input(|input, window, cx| {
            assert_eq!(
                input
                    .selected_text_range(false, window, cx)
                    .map(|selection| (selection.range, selection.reversed)),
                Some((4..4, false))
            );

            let mut adjusted = None;
            assert_eq!(
                input.text_for_range(2..3, &mut adjusted, window, cx),
                Some("😀".to_owned())
            );
            assert_eq!(adjusted, Some(1..3));

            let mut adjusted_end = None;
            assert_eq!(
                input.text_for_range(1..2, &mut adjusted_end, window, cx),
                Some("😀".to_owned())
            );
            assert_eq!(adjusted_end, Some(1..3));

            let emoji_bounds = input
                .bounds_for_range(1..3, text_area, window, cx)
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

            input.replace_and_mark_text_in_range(None, "😀x", Some(0..2), window, cx);
            assert_eq!(input.marked_text_range(window, cx), Some(4..7));
            assert_eq!(
                input
                    .selected_text_range(false, window, cx)
                    .map(|selection| (selection.range, selection.reversed)),
                Some((4..6, false))
            );
        });

        harness.cx.simulate_keystrokes("secondary-a");
        assert_eq!(
            harness.update_input(|input, window, cx| input.marked_text_range(window, cx)),
            None
        );
        harness.cx.simulate_keystrokes("secondary-x");
        assert_eq!(harness.value(), "");
        assert_eq!(harness.clipboard_text().as_deref(), Some("a😀b😀x"));

        harness.update_input(|input, window, cx| {
            input.replace_and_mark_text_in_range(None, "ni", None, window, cx);
            assert_eq!(input.marked_text_range(window, cx), Some(0..2));
            input.replace_text_in_range(None, "你", window, cx);
            assert_eq!(input.value(), "你");
            assert_eq!(input.marked_text_range(window, cx), None);
            input.replace_and_mark_text_in_range(None, "ha", None, window, cx);
            assert_eq!(input.marked_text_range(window, cx), Some(1..3));
            window.blur(cx);
        });
        harness.cx.run_until_parked();
        assert_eq!(
            harness.update_input(|input, window, cx| input.marked_text_range(window, cx)),
            None
        );
    }
}
