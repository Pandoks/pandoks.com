import { classifyImage } from '../ImageClassifier';
import ImageClassifierModule from '../ImageClassifierModule';

jest.mock('../ImageClassifierModule', () => ({
  __esModule: true,
  default: { classifyImage: jest.fn().mockResolvedValue([]) }
}));

const mockedModule = jest.mocked(ImageClassifierModule);

describe('classifyImage', () => {
  beforeEach(() => mockedModule.classifyImage.mockClear());

  it('forwards the uri and applies the default minConfidence of 0.5', async () => {
    await classifyImage({ uri: 'file://cat.jpg' });
    expect(mockedModule.classifyImage).toHaveBeenCalledWith('file://cat.jpg', 0.5);
  });

  it('forwards a caller-supplied minConfidence', async () => {
    await classifyImage({ uri: 'file://cat.jpg', options: { minConfidence: 0.9 } });
    expect(mockedModule.classifyImage).toHaveBeenCalledWith('file://cat.jpg', 0.9);
  });
});
