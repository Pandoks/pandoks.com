// The non-Android stub (Metro platform resolution picks it everywhere but Android) that's no-op
import stub from '../WidgetAndroidModule';

describe('WidgetAndroidModule stub', () => {
  it('reports no stored widget state', async () => {
    await expect(stub.getWidgetState('Counter')).resolves.toBeNull();
  });

  it('no-ops state writes and widget refreshes', async () => {
    await expect(stub.setWidgetState('Counter', '{}')).resolves.toBeUndefined();
    await expect(stub.updateWidgets()).resolves.toBeUndefined();
  });

  it('declines pin requests', async () => {
    await expect(stub.requestPinWidget('Counter')).resolves.toBe(false);
  });

  it('returns an inert subscription', () => {
    const subscription = stub.addListener('onWidgetInteraction', jest.fn());
    expect(() => subscription.remove()).not.toThrow();
  });
});
