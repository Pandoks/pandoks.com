import { requireNativeModule, requireNativeView } from 'expo';
import { createContext, use, useState } from 'react';
import { type NativeSyntheticEvent, useWindowDimensions, type ViewProps } from 'react-native';

export type Rect = { x: number; y: number; width: number; height: number };
export type ReservedRegion = { kind: 'division' | 'occlusion'; frame: Rect; active: boolean };
export type Posture = 'flat' | 'book' | 'tabletop';

const ReservedRegions = requireNativeModule<{ getRegions(): ReservedRegion[] }>('ReservedRegions');

const ReservedRegionsView = requireNativeView<
  ViewProps & {
    onRegionsChange: (event: NativeSyntheticEvent<{ regions: ReservedRegion[] }>) => void;
  }
>('ReservedRegions');

const ReservedRegionsContext = createContext<ReservedRegion[] | null>(null);

/** Shares the window's reserved regions, in window coordinates, with its descendants. */
export function ReservedRegionsProvider(props: ViewProps) {
  const { width, height } = useWindowDimensions();
  const [snapshot, setSnapshot] = useState(() => ({
    width,
    height,
    regions: ReservedRegions.getRegions()
  }));

  // NOTE: the view's event lands frames after a resize, so read the new regions in the same render
  if (snapshot.width !== width || snapshot.height !== height) {
    setSnapshot({ width, height, regions: ReservedRegions.getRegions() });
  }

  return (
    <ReservedRegionsContext value={snapshot.regions}>
      <ReservedRegionsView
        {...props}
        onRegionsChange={(event) =>
          setSnapshot((previous) => ({ ...previous, regions: event.nativeEvent.regions }))
        }
      />
    </ReservedRegionsContext>
  );
}

export function useReservedRegions({ includeInactive = false } = {}): ReservedRegion[] {
  const regions = use(ReservedRegionsContext);
  if (!regions) {
    throw new Error('useReservedRegions must be used inside ReservedRegionsProvider');
  }
  return includeInactive ? regions : regions.filter((region) => region.active);
}

/** Reads the active fold's orientation, since iOS has no posture API. */
export function usePosture(): Posture {
  const fold = useReservedRegions().find((region) => region.kind === 'division');
  if (!fold) {
    return 'flat';
  }
  return fold.frame.height > fold.frame.width ? 'book' : 'tabletop';
}
