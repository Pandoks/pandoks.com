import {
  addWidgetInteractionListener,
  getWidgetState,
  requestPinWidget,
  setWidgetState,
  updateWidgets
} from '../WidgetAndroid';
import WidgetAndroidModule from '../WidgetAndroidModule';

jest.mock('../WidgetAndroidModule', () => ({
  __esModule: true,
  default: {
    setWidgetState: jest.fn().mockResolvedValue(undefined),
    getWidgetState: jest.fn().mockResolvedValue(null),
    updateWidgets: jest.fn().mockResolvedValue(undefined),
    requestPinWidget: jest.fn().mockResolvedValue(true),
    addListener: jest.fn().mockReturnValue({ remove: jest.fn() })
  }
}));

const mockedModule = jest.mocked(WidgetAndroidModule);

describe('WidgetAndroid', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serializes state to JSON before handing it to the native module', async () => {
    await setWidgetState('Counter', { count: 3, label: 'taps' });
    expect(mockedModule.setWidgetState).toHaveBeenCalledWith(
      'Counter',
      JSON.stringify({ count: 3, label: 'taps' })
    );
  });

  it('parses stored JSON state', async () => {
    mockedModule.getWidgetState.mockResolvedValueOnce('{"count":7}');
    await expect(getWidgetState('Counter')).resolves.toEqual({ count: 7 });
    expect(mockedModule.getWidgetState).toHaveBeenCalledWith('Counter');
  });

  it('returns null when no state is stored', async () => {
    await expect(getWidgetState('Counter')).resolves.toBeNull();
  });

  it('forwards updateWidgets', async () => {
    await updateWidgets();
    expect(mockedModule.updateWidgets).toHaveBeenCalled();
  });

  it('forwards requestPinWidget and resolves the native result', async () => {
    await expect(requestPinWidget('Counter')).resolves.toBe(true);
    expect(mockedModule.requestPinWidget).toHaveBeenCalledWith('Counter');
  });

  it('subscribes to onWidgetInteraction', () => {
    const listener = jest.fn();
    const subscription = addWidgetInteractionListener(listener);
    expect(mockedModule.addListener).toHaveBeenCalledWith('onWidgetInteraction', listener);
    expect(subscription.remove).toBeDefined();
  });
});
