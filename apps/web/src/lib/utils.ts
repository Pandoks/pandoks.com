import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';

export const downloadSignedUrlImage = async ({
  url,
  dir,
  name
}: {
  url: string;
  dir: string;
  name: string;
}): Promise<string> => {
  await fs.promises.mkdir(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;

    client
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download image: ${url}`));
          return;
        }

        const contentType = response.headers['content-type'];
        const extension = getImageExtensionFromMime(contentType);

        const outputPath = path.join(dir, `${name}${extension}`);
        const file = fs.createWriteStream(outputPath);
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(`downloadSignedUrlImage: Downloaded image: ${url} to ${outputPath}`);
          resolve(outputPath);
        });

        file.on('error', (err) => {
          fs.unlink(outputPath, () => {
            reject(new Error(`File writing error: ${err.message}`));
          });
        });
      })
      .on('error', (err) => {
        reject(new Error(`Request error: ${err.message}`));
      });
  });
};

export const getImageExtensionFromSignedUrlImage = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} - ${response.statusText}`);
  }

  const contentType = response.headers.get('Content-Type');
  return getImageExtensionFromMime(contentType);
};

export const getImageExtensionFromMime = (mime: string | undefined | null): string => {
  if (!mime) {
    throw new Error('No mime type provided');
  }

  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpeg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    case 'image/bmp':
      return '.bmp';
    case 'image/tiff':
      return '.tiff';
    case 'image/x-icon':
      return '.ico';
    default:
      throw new Error(`Unsupported image mime type: ${mime}`);
  }
};
