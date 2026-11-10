// Command updates serves the Expo update baked into its image over the Expo Updates v1 protocol, and signs
// every manifest and directive with RSA-SHA256.
package main

import (
	"crypto"
	"crypto/md5" // #nosec G501 -- the protocol's asset key is an MD5 digest, used as a name, not for security
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type asset struct {
	Hash          string `json:"hash"`
	Key           string `json:"key"`
	ContentType   string `json:"contentType"`
	FileExtension string `json:"fileExtension,omitempty"`
	URL           string `json:"url"`
}

type manifest struct {
	ID             string         `json:"id"`
	CreatedAt      string         `json:"createdAt"`
	RuntimeVersion string         `json:"runtimeVersion"`
	LaunchAsset    asset          `json:"launchAsset"`
	Assets         []asset        `json:"assets"`
	Metadata       struct{}       `json:"metadata"`
	Extra          map[string]any `json:"extra"`
}

type signedPart struct {
	name, body, signature string
}

type signedManifest struct {
	id   string
	part signedPart
}

type server struct {
	// A platform's update, signed once for each runtime version it serves
	updates       map[string]map[string]signedManifest
	noUpdate      signedPart
	assetPaths    map[string]string
	assetContents map[string]string
}

func main() {
	if err := run(); err != nil {
		slog.Error("updates failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	key, err := parseSigningKey(os.Getenv("SIGNING_KEY"))
	if err != nil {
		return err
	}
	publicURL, err := url.Parse(os.Getenv("URL"))
	if err != nil || publicURL.Host == "" {
		return fmt.Errorf("URL %q isn't the URL clients reach this server at", os.Getenv("URL"))
	}
	updates, err := newServer("/updates", publicURL.String(), key)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Addr: ":8080", Handler: updates, ReadHeaderTimeout: 10 * time.Second}
	return httpServer.ListenAndServe()
}

func parseSigningKey(signingKey string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(signingKey))
	if block == nil {
		return nil, errors.New("SIGNING_KEY isn't a PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("SIGNING_KEY isn't a PKCS #8 private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("SIGNING_KEY isn't an RSA key, the only kind expo-updates verifies")
	}
	return key, nil
}

// newServer reads the export in dir: expo export's output, created-at, and for each build of the app the update
// serves, a runtime-version-<platform><build>.json from expo-updates runtimeversion:resolve and the public
// expo-config<build>.json, where <build> is empty for production. It signs every response up front.
func newServer(dir, publicURL string, key *rsa.PrivateKey) (*server, error) {
	var metadata struct {
		FileMetadata map[string]struct {
			Bundle string `json:"bundle"`
			Assets []struct {
				Path string `json:"path"`
				Ext  string `json:"ext"`
			} `json:"assets"`
		} `json:"fileMetadata"`
	}
	if err := readJSON(filepath.Join(dir, "metadata.json"), &metadata); err != nil {
		return nil, err
	}
	createdAt, err := os.ReadFile(filepath.Join(dir, "created-at")) // #nosec G304 -- a file of the export baked into the image
	if err != nil {
		return nil, err
	}

	updatesServer := &server{
		updates:       map[string]map[string]signedManifest{},
		assetPaths:    map[string]string{},
		assetContents: map[string]string{},
	}
	if updatesServer.noUpdate, err = signPart(key, "directive", map[string]string{"type": "noUpdateAvailable"}); err != nil {
		return nil, err
	}
	for platform, files := range metadata.FileMetadata {
		runtimeFiles, err := filepath.Glob(filepath.Join(dir, "runtime-version-"+platform+"*.json"))
		if err != nil {
			return nil, err
		}
		if len(runtimeFiles) == 0 {
			return nil, fmt.Errorf("%s has no runtime-version-%s*.json", platform, platform)
		}
		launchAsset, err := updatesServer.addAsset(dir, publicURL, files.Bundle, "", "application/javascript")
		if err != nil {
			return nil, err
		}
		assets := []asset{}
		for _, file := range files.Assets {
			fileAsset, err := updatesServer.addAsset(dir, publicURL, file.Path, file.Ext, mime.TypeByExtension("."+file.Ext))
			if err != nil {
				return nil, err
			}
			assets = append(assets, fileAsset)
		}

		updatesServer.updates[platform] = map[string]signedManifest{}
		for _, runtimeFile := range runtimeFiles {
			var runtime struct {
				RuntimeVersion string `json:"runtimeVersion"`
			}
			if err := readJSON(runtimeFile, &runtime); err != nil {
				return nil, err
			}
			if runtime.RuntimeVersion == "" {
				return nil, fmt.Errorf("%s has no runtime version; set runtimeVersion in the app config", runtimeFile)
			}
			build := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(runtimeFile), "runtime-version-"+platform), ".json")
			var expoClient map[string]any
			if err := readJSON(filepath.Join(dir, "expo-config"+build+".json"), &expoClient); err != nil {
				return nil, err
			}
			update := manifest{
				CreatedAt:      strings.TrimSpace(string(createdAt)),
				RuntimeVersion: runtime.RuntimeVersion,
				LaunchAsset:    launchAsset,
				Assets:         assets,
				Extra:          map[string]any{"expoClient": expoClient},
			}
			// NOTE: expo-updates launches the newest update it has, so every build, even of old code, is a new update
			// and reverting a bad one on main reaches phones that downloaded it
			content, err := json.Marshal(update)
			if err != nil {
				return nil, err
			}
			update.ID = uuidFromContent(content)
			signed, err := signPart(key, "manifest", update)
			if err != nil {
				return nil, err
			}
			updatesServer.updates[platform][runtime.RuntimeVersion] = signedManifest{id: update.ID, part: signed}
		}
	}
	return updatesServer, nil
}

func readJSON(path string, value any) error {
	data, err := os.ReadFile(path) // #nosec G304 -- the path is a file of the export baked into the image
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, value); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func (updatesServer *server) addAsset(dir, publicURL, path, extension, contentType string) (asset, error) {
	data, err := os.ReadFile(filepath.Join(dir, path)) // #nosec G304 -- the path comes from the export's own metadata.json
	if err != nil {
		return asset{}, err
	}
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	sha := sha256.Sum256(data)
	md5Sum := md5.Sum(data) // #nosec G401 -- the protocol's asset key is an MD5 digest, used as a name, not for security
	hash := base64.RawURLEncoding.EncodeToString(sha[:])
	updatesServer.assetPaths[hash] = filepath.Join(dir, path)
	updatesServer.assetContents[hash] = contentType
	fileAsset := asset{Hash: hash, Key: hex.EncodeToString(md5Sum[:]), ContentType: contentType, URL: publicURL + "/assets/" + hash}
	if extension != "" {
		fileAsset.FileExtension = "." + extension
	}
	return fileAsset, nil
}

func uuidFromContent(content []byte) string {
	sum := sha256.Sum256(content)
	sum[6] = sum[6]&0x0f | 0x40
	sum[8] = sum[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}

func signPart(key *rsa.PrivateKey, name string, value any) (signedPart, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return signedPart{}, err
	}
	digest := sha256.Sum256(body)
	signature, err := rsa.SignPKCS1v15(nil, key, crypto.SHA256, digest[:])
	if err != nil {
		return signedPart{}, err
	}
	return signedPart{name: name, body: string(body), signature: base64.StdEncoding.EncodeToString(signature)}, nil
}

func (updatesServer *server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if hash, ok := strings.CutPrefix(request.URL.Path, "/assets/"); ok {
		updatesServer.serveAsset(response, request, hash)
		return
	}
	if request.URL.Path != "/" {
		http.NotFound(response, request)
		return
	}

	runtimeVersion := request.Header.Get("expo-runtime-version")
	platformUpdates, ok := updatesServer.updates[request.Header.Get("expo-platform")]
	if runtimeVersion == "" || !ok {
		http.Error(response, "Missing runtime version, or unknown platform", http.StatusBadRequest)
		return
	}
	response.Header().Set("expo-protocol-version", "1")
	response.Header().Set("expo-sfv-version", "0")
	response.Header().Set("cache-control", "private, max-age=0")
	update, ok := platformUpdates[runtimeVersion]
	if !ok {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Header.Get("expo-current-update-id") == update.id {
		writePart(response, updatesServer.noUpdate)
		return
	}
	writePart(response, update.part)
}

func (updatesServer *server) serveAsset(response http.ResponseWriter, request *http.Request, hash string) {
	path, ok := updatesServer.assetPaths[hash]
	if !ok {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("content-type", updatesServer.assetContents[hash])
	response.Header().Set("cache-control", "public, max-age=31536000, immutable")
	http.ServeFile(response, request, path)
}

func writePart(response http.ResponseWriter, part signedPart) {
	boundary := rand.Text()
	response.Header().Set("content-type", "multipart/mixed; boundary="+boundary)
	_, _ = fmt.Fprint(response, strings.Join([]string{
		"--" + boundary,
		`content-disposition: form-data; name="` + part.name + `"`,
		"content-type: application/json; charset=utf-8",
		`expo-signature: sig="` + part.signature + `", keyid="main", alg="rsa-v1_5-sha256"`,
		"",
		part.body,
		"--" + boundary + "--",
		"",
	}, "\r\n"))
}
