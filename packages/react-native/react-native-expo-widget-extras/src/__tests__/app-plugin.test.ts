import {
  assertValidWidgetNames,
  createWidgetInfoXml,
  createWidgetReceiver,
  createWidgetStringsXml,
  infoResourceName,
  mergeWidgetReceivers,
  snakeCase,
  WIDGET_NAME_METADATA,
  type WidgetReceiver
} from '../../app.plugin';

const COUNTER = {
  name: 'Counter',
  displayName: 'Counter',
  description: 'Increment from your home screen'
};

describe('widget-resources', () => {
  it('snake-cases multi-word widget names for resource names', () => {
    expect(snakeCase('Counter')).toBe('counter');
    expect(snakeCase('StreakTracker')).toBe('streak_tracker');
    expect(infoResourceName({ ...COUNTER, name: 'StreakTracker' })).toBe(
      'widget_streak_tracker_info'
    );
  });

  it('generates provider info XML with defaults and a push-only update period', () => {
    const xml = createWidgetInfoXml(COUNTER);
    expect(xml).toContain('android:minWidth="180dp"');
    expect(xml).toContain('android:targetCellWidth="3"');
    expect(xml).toContain('android:updatePeriodMillis="0"');
    expect(xml).toContain('android:resizeMode="horizontal|vertical"');
    expect(xml).toContain('android:description="@string/widget_counter_description"');
  });

  it('respects explicit sizing and resize mode', () => {
    const xml = createWidgetInfoXml({
      ...COUNTER,
      minWidth: 250,
      targetCellWidth: 4,
      resizeMode: 'none'
    });
    expect(xml).toContain('android:minWidth="250dp"');
    expect(xml).toContain('android:targetCellWidth="4"');
    expect(xml).toContain('android:resizeMode="none"');
  });

  it('escapes XML special characters in strings', () => {
    const xml = createWidgetStringsXml([{ ...COUNTER, description: 'Track & count <fast>' }]);
    expect(xml).toContain('Track &amp; count &lt;fast&gt;');
    expect(xml).toContain('<string name="widget_counter_label">Counter</string>');
  });

  it('builds a manifest receiver honoring the naming contract and marker meta-data', () => {
    const receiver = createWidgetReceiver(COUNTER);
    expect(receiver.$['android:name']).toBe('.widgets.CounterWidgetReceiver');
    expect(receiver.$['android:exported']).toBe('true');
    expect(receiver['intent-filter']?.[0]?.action?.[0]?.$['android:name']).toBe(
      'android.appwidget.action.APPWIDGET_UPDATE'
    );
    const metaData = receiver['meta-data'] ?? [];
    expect(metaData.some((entry) => entry.$['android:name'] === WIDGET_NAME_METADATA)).toBe(true);
    expect(
      metaData.some((entry) => entry.$['android:resource'] === '@xml/widget_counter_info')
    ).toBe(true);
  });

  it('replaces stale plugin receivers on re-prebuild but preserves foreign ones', () => {
    const foreign: WidgetReceiver = {
      $: { 'android:name': '.SomeOtherReceiver', 'android:exported': 'false' }
    };
    const stale = createWidgetReceiver({ ...COUNTER, name: 'Removed' });

    const merged = mergeWidgetReceivers([foreign, stale], [COUNTER]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(foreign);
    expect(merged[1].$['android:name']).toBe('.widgets.CounterWidgetReceiver');

    // re-running over its own output must not grow the list
    const again = mergeWidgetReceivers(merged, [COUNTER]);
    expect(again).toHaveLength(2);
    expect(again.map((receiver) => receiver.$['android:name'])).toEqual([
      '.SomeOtherReceiver',
      '.widgets.CounterWidgetReceiver'
    ]);
  });

  it('rejects widget names that cannot become Kotlin class names', () => {
    expect(() => assertValidWidgetNames([COUNTER])).not.toThrow();
    expect(() => assertValidWidgetNames([{ ...COUNTER, name: 'My Widget' }])).toThrow(/must match/);
    expect(() => assertValidWidgetNames([{ ...COUNTER, name: '9Lives' }])).toThrow(/must match/);
  });
});
