package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

const testURL = "https://mobile-updates.test/app"

var signingKey = func() *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key
}()

func writeExport(t *testing.T, createdAt string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"metadata.json": `{"version":0,"bundler":"metro","fileMetadata":{
			"ios":{"bundle":"_expo/static/js/ios/entry.hbc","assets":[{"path":"assets/icon","ext":"png"}]},
			"android":{"bundle":"_expo/static/js/android/entry.hbc","assets":[]}}}`,
		"expo-config-dev.json":              `{"slug":"app","name":"App Dev"}`,
		"expo-config.json":                  `{"slug":"app","name":"App"}`,
		"created-at":                        createdAt + "\n",
		"runtime-version-ios-dev.json":      `{"runtimeVersion":"ios-dev-fingerprint"}`,
		"runtime-version-ios.json":          `{"runtimeVersion":"ios-fingerprint"}`,
		"runtime-version-android.json":      `{"runtimeVersion":"android-fingerprint"}`,
		"_expo/static/js/ios/entry.hbc":     "ios bundle",
		"_expo/static/js/android/entry.hbc": "android bundle",
		"assets/icon":                       "\x89PNG icon",
	}
	for path, content := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func newTestServer(t *testing.T, createdAt string) *server {
	t.Helper()
	mobileUpdatesServer, err := newServer(writeExport(t, createdAt), testURL, signingKey)
	if err != nil {
		t.Fatal(err)
	}
	return mobileUpdatesServer
}

func request(handler http.Handler, path string, headers map[string]string) *httptest.ResponseRecorder {
	httpRequest := httptest.NewRequest(http.MethodGet, path, nil)
	for name, value := range headers {
		httpRequest.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httpRequest)
	return recorder
}

// readSignedPart checks the response is one part with a valid signature and returns its name and body.
func readSignedPart(t *testing.T, response *httptest.ResponseRecorder) (string, []byte) {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", response.Code)
	}
	if response.Header().Get("expo-protocol-version") != "1" {
		t.Fatalf("expo-protocol-version %q, want 1", response.Header().Get("expo-protocol-version"))
	}
	_, params, err := mime.ParseMediaType(response.Header().Get("content-type"))
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(response.Body, params["boundary"])
	part, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(part)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.NextPart(); err != io.EOF {
		t.Fatalf("got a second part or a bad ending: %v", err)
	}

	signature := regexp.MustCompile(`sig="([^"]+)", keyid="main", alg="rsa-v1_5-sha256"`).FindStringSubmatch(part.Header.Get("expo-signature"))
	if signature == nil {
		t.Fatalf("expo-signature %q", part.Header.Get("expo-signature"))
	}
	decoded, err := base64.StdEncoding.DecodeString(signature[1])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	if err := rsa.VerifyPKCS1v15(&signingKey.PublicKey, crypto.SHA256, digest[:], decoded); err != nil {
		t.Fatalf("signature doesn't verify: %v", err)
	}
	return part.FormName(), body
}

func TestServesASignedManifestWhoseAssetsMatchTheirHashes(t *testing.T) {
	mobileUpdatesServer := newTestServer(t, "2026-11-09T00:00:00Z")
	name, body := readSignedPart(t, request(mobileUpdatesServer, "/", map[string]string{
		"expo-platform":        "ios",
		"expo-runtime-version": "ios-fingerprint",
	}))
	if name != "manifest" {
		t.Fatalf("part %q, want manifest", name)
	}
	var update manifest
	if err := json.Unmarshal(body, &update); err != nil {
		t.Fatal(err)
	}
	if update.RuntimeVersion != "ios-fingerprint" || update.CreatedAt != "2026-11-09T00:00:00Z" ||
		update.Extra["expoClient"].(map[string]any)["slug"] != "app" {
		t.Fatalf("manifest %s", body)
	}
	if len(update.Assets) != 1 || update.Assets[0].FileExtension != ".png" || update.Assets[0].ContentType != "image/png" {
		t.Fatalf("assets %+v", update.Assets)
	}

	for _, fileAsset := range append(update.Assets, update.LaunchAsset) {
		path := regexp.MustCompile("^" + regexp.QuoteMeta(testURL) + "(/assets/.+)$").FindStringSubmatch(fileAsset.URL)
		if path == nil {
			t.Fatalf("asset URL %q isn't under %s", fileAsset.URL, testURL)
		}
		response := request(mobileUpdatesServer, path[1], nil)
		sum := sha256.Sum256(response.Body.Bytes())
		if response.Code != http.StatusOK || base64.RawURLEncoding.EncodeToString(sum[:]) != fileAsset.Hash ||
			response.Header().Get("content-type") != fileAsset.ContentType {
			t.Fatalf("asset %s: status %d, content-type %q", fileAsset.URL, response.Code, response.Header().Get("content-type"))
		}
	}
	if response := request(mobileUpdatesServer, "/assets/unknown", nil); response.Code != http.StatusNotFound {
		t.Fatalf("unknown asset: status %d, want 404", response.Code)
	}
}

func TestTheRunningUpdateGetsNoUpdateAvailable(t *testing.T) {
	mobileUpdatesServer := newTestServer(t, "2026-11-09T00:00:00Z")
	headers := map[string]string{"expo-platform": "android", "expo-runtime-version": "android-fingerprint"}
	_, body := readSignedPart(t, request(mobileUpdatesServer, "/", headers))
	var update manifest
	if err := json.Unmarshal(body, &update); err != nil {
		t.Fatal(err)
	}

	headers["expo-current-update-id"] = update.ID
	name, body := readSignedPart(t, request(mobileUpdatesServer, "/", headers))
	if name != "directive" || string(body) != `{"type":"noUpdateAvailable"}` {
		t.Fatalf("part %q: %s", name, body)
	}
}

func TestARebuildOfTheSameCodeIsANewUpdate(t *testing.T) {
	headers := map[string]string{"expo-platform": "ios", "expo-runtime-version": "ios-fingerprint"}
	var ids []string
	for _, createdAt := range []string{"2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z"} {
		_, body := readSignedPart(t, request(newTestServer(t, createdAt), "/", headers))
		var update manifest
		if err := json.Unmarshal(body, &update); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, update.ID)
	}
	if ids[0] == ids[1] {
		t.Fatalf("both builds are update %s, so a revert wouldn't reach phones that have the newer one", ids[0])
	}
}

func TestEachBuildGetsTheUpdateForItsRuntimeVersion(t *testing.T) {
	mobileUpdatesServer := newTestServer(t, "2026-11-09T00:00:00Z")
	builds := map[string]string{"ios-fingerprint": "App", "ios-dev-fingerprint": "App Dev"}
	for runtimeVersion := range builds {
		_, body := readSignedPart(t, request(mobileUpdatesServer, "/", map[string]string{
			"expo-platform":        "ios",
			"expo-runtime-version": runtimeVersion,
		}))
		var update manifest
		if err := json.Unmarshal(body, &update); err != nil {
			t.Fatal(err)
		}
		if update.RuntimeVersion != runtimeVersion {
			t.Fatalf("runtime version %q, want %q", update.RuntimeVersion, runtimeVersion)
		}
		if name := update.Extra["expoClient"].(map[string]any)["name"]; name != builds[runtimeVersion] {
			t.Fatalf("%s got the config named %q, want %q", runtimeVersion, name, builds[runtimeVersion])
		}
	}
}

func TestAnotherRuntimeVersionGetsNoContent(t *testing.T) {
	response := request(newTestServer(t, "2026-11-09T00:00:00Z"), "/", map[string]string{
		"expo-platform":        "ios",
		"expo-runtime-version": "older-fingerprint",
	})
	if response.Code != http.StatusNoContent || response.Header().Get("expo-protocol-version") != "1" {
		t.Fatalf("status %d, expo-protocol-version %q", response.Code, response.Header().Get("expo-protocol-version"))
	}
}

func TestRejectsAMissingRuntimeVersionOrAnUnknownPlatform(t *testing.T) {
	mobileUpdatesServer := newTestServer(t, "2026-11-09T00:00:00Z")
	for _, headers := range []map[string]string{
		{"expo-platform": "ios"},
		{"expo-platform": "web", "expo-runtime-version": "ios-fingerprint"},
		{"expo-runtime-version": "ios-fingerprint"},
	} {
		if response := request(mobileUpdatesServer, "/", headers); response.Code != http.StatusBadRequest {
			t.Fatalf("%v: status %d, want 400", headers, response.Code)
		}
	}
}
