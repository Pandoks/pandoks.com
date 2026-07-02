// The non-Android stub (Metro platform resolution picks it everywhere but Android) that's no-op
import stub from '../LiveUpdatesAndroidModule';

describe('LiveUpdatesAndroidModule stub', () => {
  it('resolves the never-granted permission shape', async () => {
    await expect(stub.requestPermissionsAsync()).resolves.toEqual({ granted: false });
  });

  it('reports no promotion capability and no active live updates', async () => {
    expect(stub.canPromote()).toBe(false);
    await expect(stub.getActive()).resolves.toEqual([]);
  });

  it('no-ops start, update and end', async () => {
    await expect(stub.start('Focus', '{}')).resolves.toBeUndefined();
    await expect(stub.update('Focus', '{}')).resolves.toBeUndefined();
    await expect(stub.end('Focus')).resolves.toBeUndefined();
  });

  it('returns an inert subscription', () => {
    const subscription = stub.addListener('onLiveUpdateInteraction', jest.fn());
    expect(() => subscription.remove()).not.toThrow();
  });
});
