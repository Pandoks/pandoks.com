export interface Classification {
  label: string; // human readable label eg. "golden retriever"
  confidence: number; // model confidence in [0, 1]
}

export interface ClassifyOptions {
  minConfidence: number; // drop results below this score. Default: 0.5
}
