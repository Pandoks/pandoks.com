export type WidgetState = Record<string, unknown>;

export interface WidgetInteractionEvent<TTarget extends string = string> {
  source: string; // Widget that triggered the interaction (the widget's name, e.g. 'Counter')
  target: TTarget; // Control that was pressed (e.g. 'increment')
  timestamp: number; // epoch ms
}

export type WidgetAndroidEvents = {
  onWidgetInteraction: (event: WidgetInteractionEvent) => void;
};
