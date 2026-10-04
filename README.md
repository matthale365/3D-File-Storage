# Parts Library

A free website, hosted on GitHub Pages, where people can preview, rotate, zoom, measure and download your 3D files.

- **STEP / STP** (and IGES): previewed by converting the CAD file in the visitor's browser.
- **3MF**, including **Bambu Studio** project files: previewed in the filament colour, with the plate picture used as the gallery thumbnail.
- **STL**: previewed too.
- **Any other file** in a part's folder (PDF drawings, F3D, etc.) shows up as a download.

## Adding a part

Make a folder inside `models/` and put the files in it:

```
models/
  phone-stand/
    phone-stand.step
    phone-stand.3mf
    info.json        ← optional
    thumbnail.png    ← optional
```

Push to GitHub. About two minutes later the part is on the site. Nothing else needs editing.

The folder name becomes the part's title (`phone-stand` → "Phone stand"). To set a nicer title, description or tags, add an `info.json`:

```json
{
  "title": "Phone stand, 15° tilt",
  "description": "Fits phones up to 12 mm thick with a case.",
  "tags": ["desk", "phone"]
}
```

Add `"preview": "phone-stand.3mf"` to show the 3MF first instead of the STEP.

Thumbnails are made automatically: a Bambu 3MF's plate picture if there is one, otherwise a render of the part. Drop a `thumbnail.png` (or .jpg) in the folder to use your own.

## One-time setup

1. Create a **public** repository on GitHub and upload everything in this folder, including the hidden `.github` folder.
2. In the repo, open **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. Wait for "Publish site" to finish with a green check, or press **Run workflow** to start it.
4. The site is at `https://<your-username>.github.io/<repo-name>/`.

Change the site title and intro text in `site.config.js`.

## Limits

- GitHub rejects single files over **100 MB** and warns at 50 MB. For bigger files, use [Git LFS](https://git-lfs.com). The publish workflow already fetches LFS files, so they still preview and download. LFS has its own storage and bandwidth quotas on your GitHub account.
- Keep the whole site under about **1 GB**.
- Large STEP files take a while to preview because the browser does the CAD conversion. Files over 40 MB wait for a click before loading (change `autoPreviewLimitMB` in `site.config.js`).
- Measurements snap to the corners of the displayed mesh. They are accurate for straight edges and flat faces, and close (not exact) on curves.

## Previewing on your own computer (optional)

Requires [Node.js](https://nodejs.org) and Python 3.

```
npm install
npm run serve
```

Then open <http://localhost:8000>. Run `npm run thumbnails` to render thumbnails locally as well.

## How it works

- `index.html`, `assets/`: the website. It uses [three.js](https://threejs.org) for 3D and [occt-import-js](https://github.com/kovacsv/occt-import-js) (the OpenCascade CAD kernel compiled to WebAssembly) to read STEP files, both loaded from the jsDelivr CDN.
- `scripts/build.mjs`: scans `models/` and writes `models.json`, the list the site reads. With `--thumbnails` it opens each part in a headless browser and saves a picture.
- `.github/workflows/deploy.yml`: runs the build on every push to `main` and publishes the result to GitHub Pages. Rendered thumbnails are cached between runs, so only new or changed parts are rendered.
