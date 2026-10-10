"""
Builds the Bible Presenter manual.

Source articles are written once below in Notion-flavored (enhanced) Markdown.
Two outputs are generated:

  notion/   enhanced Markdown for the Notion API (publish-to-notion.js).
            Images point to {{IMG}}/name.png; the publisher swaps in the
            public URL of docs/manual/images on GitHub.
  import/   plain Markdown + images/ for Notion's "Import -> Markdown & CSV".
            Callouts, toggles and tables are converted to plain Markdown,
            because the importer does not understand the enhanced tags.

Run:  python3 docs/manual/build_manual.py
"""
import os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
T = "\t"

def img(name, caption):
    return f"![{caption}]({{{{IMG}}}}/{name}.png)"

def callout(icon, color, *lines):
    body = "\n".join(T + l for l in lines)
    return f'<callout icon="{icon}" color="{color}">\n{body}\n</callout>'

def toggle(title, *lines):
    body = "\n".join(T + l for l in lines)
    return f"<details>\n<summary>{title}</summary>\n{body}\n</details>"

def table(header, rows):
    out = ['<table header-row="true">']
    for r in [header] + rows:
        out.append(T + "<tr>")
        for c in r:
            out.append(T + T + f"<td>{c}</td>")
        out.append(T + "</tr>")
    out.append("</table>")
    return "\n".join(out)

A = []   # (slug, title, emoji, body)

# ---------------------------------------------------------------- 00 home
A.append(("00-home", "Bible Presenter — User Guide", "📖", "\n\n".join([
"Bible Presenter puts Bible verses, songs, presentations and media on the projector, sends lower thirds to vMix or OBS, and gives the team a stage display. It runs on Windows and macOS, and the interface is available in 27 languages.",
img("01-main-window", "Main window, Bible tab"),
"## What it does",
"- Bible: 1,048 translations in the built-in catalog, jump by reference such as John 3:16, search the whole Bible by phrase.",
"- Songs: paste lyrics in any format, automatic parts and slides, ProPresenter import.",
"- Presentations: PowerPoint (.pptx) and PDF.",
"- Media: photos and videos for announcements.",
"- Service playlist: the whole service in one running order, driven by a clicker.",
"- Live output: lower thirds for vMix and OBS with their own style.",
"- Stage display: current and next slide, clock and timer on any device on the network.",
"- Phone remote: run the service from a smartphone or tablet, nothing to install.",
"## Where to start",
"1. Install the app — see Installation and first launch.",
"2. Download a Bible translation — see Bible.",
"3. Add songs — see Songs.",
"4. Build the service — see Service playlist.",
callout("💡", "blue_bg", "The articles follow the order in which most people learn the app. Coming from ProPresenter? Start with Songs and Backgrounds and themes: both cover importing your library and themes."),
])))

# ---------------------------------------------------------------- 01 install
A.append(("01-installation", "Installation and first launch", "💾", "\n\n".join([
"There is one installer per platform.",
table(["System", "File", "Requirements"], [
    ["Windows", "Bible-Presenter_X.Y.Z_x64-setup.exe", "Windows 10 or 11, 64-bit"],
    ["macOS", "Bible-Presenter_X.Y.Z_universal.dmg", "macOS 11 or newer; Intel and Apple Silicon in one file"],
]),
"## Windows",
"1. Run the .exe file.",
"2. If Windows shows “Windows protected your PC”, click More info, then Run anyway. You only do this once: the app is not signed with a paid certificate.",
"3. Follow the installer. It installs for your Windows account only, so it doesn’t ask for an administrator password. A shortcut appears on the desktop and in the Start menu.",
"## macOS",
"1. Open the .dmg file and drag Bible Presenter into Applications.",
"2. The first time, macOS blocks the app because it is not signed with an Apple certificate. On macOS 14 and earlier: right-click the app, choose Open, then Open again. On macOS 15 and later: double-click it, close the warning, then open System Settings → Privacy & Security, scroll down and click Open Anyway. After that it opens normally.",
"3. After that it opens like any other app.",
"## Coming from version 2",
"Version 3 is a new program, much smaller and faster. Install it over version 2: the installer removes the old program, and your songs, translations, themes and playlists stay as they were, because both versions use the same data folder. Your settings are taken over on first launch. The one thing that is gone is NDI output; the web page for vMix and OBS (see Live output to vMix and OBS) stays.",
"## Second screen and projector",
"The app opens two windows: the control window and the projector window.",
"- With a second screen connected (projector or TV), the projector window opens on it full screen.",
"- Without a second screen, the projector window opens as a normal 1280×720 window. Handy for preparing on a laptop.",
"- If you connect the projector after launch, the window moves to it on its own.",
callout("⚠️", "yellow_bg", "On Windows, set the displays to Extend these displays, not Duplicate. In duplicate mode the app cannot see a second screen."),
"## First steps",
"1. Pick the interface language: settings button at the top right → Language.",
"2. Download a Bible translation: Bible tab → Translations.",
"3. For PowerPoint files, install the free LibreOffice (libreoffice.org). PDF files do not need it.",
])))

# ---------------------------------------------------------------- 02 interface
A.append(("02-interface", "The interface", "🧭", "\n\n".join([
img("01-main-window", "Control window"),
"The control window has three parts.",
"## Top bar",
img("02-topbar", "Top bar"),
table(["Element", "Purpose"], [
    ["Bible, Songs, Presentations, Media tabs", "Sections of the app"],
    ["Translation list", "The Bible translation verses come from"],
    ["Settings button (screen with sliders)", "Settings: language, slide transition, version, update check"],
    ["Remote", "Turns a phone or tablet into a remote. A green dot means it is on"],
    ["Live output", "Lower thirds for vMix and OBS, and the stage display. A green dot means the server is running"],
    ["Themes", "How text looks on the projector"],
]),
"## Work area",
"Changes with the tab. A list on the left (books, songs, presentations), content and preview on the right.",
"## Bottom strip",
"Two tabs:",
"- **Service Playlist** — everything planned for the service, in order.",
"- **Song Backgrounds** — photos and videos you can put under the text during the service.",
"Drag the top edge of the strip to change its height. The slider on the right changes the size of slide cards.",
"## Clear buttons",
img("09-clear-bar", "Clear buttons above the bottom strip"),
"Always in the same place, above the bottom strip:",
table(["Button", "What it does"], [
    ["Text", "Removes the words; background and video keep playing"],
    ["Screen", "Clears the projector completely"],
    ["Live output", "Clears only the stream and leaves the projector alone. Stays cleared until pressed again"],
]),
"## Settings",
img("08-settings", "Settings menu"),
"- **Language** — switches the interface language at once, no restart.",
"- **Slide transition (crossfade)** — length of the fade between slides, 400 ms by default. No transition (instant) switches immediately.",
"- **Check for updates** — checks for a new version manually.",
"- The bottom shows the app version, the install folder and the folder with your data.",
])))

# ---------------------------------------------------------------- 03 bible
A.append(("03-bible", "Bible", "✝️", "\n\n".join([
"## Downloading a translation",
"No translations are included after installation. Download the ones you need once:",
"1. Bible tab → Translations.",
"2. Search for a language or a translation name.",
"3. Click the download arrow next to the translation. A few seconds later it appears in the translation list on the top bar.",
img("07-bible-catalog", "Translation catalog"),
"The catalog has 1,048 translations in 244 languages. Downloaded ones show a green check mark.",
toggle("Importing your own XML file",
    "The round arrow next to the search field refreshes the catalog from the internet, in case new translations have been added.",
"If a translation is not in the catalog, load an XML file with the XML button next to the search field.",
    "Supported formats: Beblia, Zefania and OSIS."),
"## Choosing a verse",
img("03-bible-columns", "Books, chapters and verses"),
"Three columns: book → chapter → verse. Each verse number shows its text, so you can find the passage by reading. Filter books narrows the book list.",
"Book names come from the translation. If a translation has no names of its own, they are shown in the translation's language, so an English Bible is always labelled John 3:16, whatever the interface language.",
"## Jumping to a reference",
"Type a reference in the field at the top and press Enter:",
table(["What you type", "Result"], [
    ["John 3:16", "Gospel of John, chapter 3, verse 16"],
    ["Ps 23", "Psalm 23, first verse"],
    ["1 Cor 13:4", "1 Corinthians 13:4"],
    ["Jn 3:16, Rev 21:4", "Standard abbreviations work"],
]),
"Standard abbreviations are understood in English, Russian and Ukrainian (Mt, Mk, Lk, Jn, Rom, Ps, Rev, Мф, Ин, Пс, Ів and others), as well as full names, including different spellings.",
callout("ℹ️", "blue_bg", "Russian and some Ukrainian translations number the books of Kings differently: “1 Царств” is 1 Samuel. The app reads the numbering from the selected translation, so 1 Цар opens the right book either way."),
"## Searching by phrase",
"Don't remember the reference? Type words from the verse in the same field and press Enter. The search covers the whole Bible.",
img("06-bible-search", "Search results with highlighted matches"),
"- Click a result to open that passage.",
"- Double-click to put it on the projector straight away.",
"The list shows up to 200 matches. If there are more, it says so — add another word to narrow the search.",
"A single word that is also a book name, such as Job or Acts, opens that book. Any other word without numbers is searched for.",
"## Showing a verse",
img("04-bible-preview", "Screen preview"),
"The preview on the right shows what the room will see, background included.",
"- **Show on screen** — puts the verse on the projector.",
"- **Clear** — removes it.",
"- **+ To playlist** — adds the verse to the service playlist.",
img("05-projector-verse", "Verse on the projector"),
"Once a verse is on screen, the right arrow or the clicker shows the next verse; the left arrow shows the previous one.",
])))

# ---------------------------------------------------------------- 04 songs
A.append(("04-songs", "Songs", "🎵", "\n\n".join([
img("10-songs-editor", "Song editor"),
"The song library, grouped by collection, is on the left; the editor for the selected song is on the right. Each part of the song (verse, chorus) has its own color.",
"## A new song from existing lyrics",
"1. Click Paste lyrics.",
"2. Paste the lyrics.",
"3. Choose how many lines go on each slide.",
"4. Click Create slides.",
img("15-paste-dialog", "Pasting lyrics"),
img("16-paste-result", "Result: parts and slides"),
"The app splits the text into parts and slides by itself:",
"- Headings are recognised in any form: [Verse 1], Chorus:, CHORUS, Refrain, Estribillo — in 8 languages.",
"- Without headings, the repeated block becomes the chorus and the rest become verses.",
"- Your own labels, such as Interlude, are kept as written.",
"- Repeat marks are understood and removed from the slides: Chorus x2, 2x Chorus, Chorus (2 times), a line ending in (x2), a separate (x2) line under a block, / … / x2 and ||: … :||. The part or line is repeated as many times as written.",
"- A heading with no words under it, such as a second Chorus after verse 2, reuses the words that part had earlier.",
"- Instrumental breaks are recognised in any form: Instrumental, Interlude, Instrumental (guitar), --- Interlude ---. They become a blank slide.",
"- Numbered hymn verses (1. Amazing grace…) become Verse 1, Verse 2…; a lone title line at the top and an End line at the bottom are left out.",
"- Long lines are wrapped so the text stays readable on screen.",
callout("💡", "blue_bg", "You can also paste into a song that is already open: the new parts are added at the end."),
"## Song parts",
img("11-song-sections", "Song parts"),
"- Pick the part type in its header: Verse, Chorus, Pre-Chorus, Bridge, Tag, Intro, Instrumental, Outro.",
"- Part names follow the interface language: “Verse 2” in English, “Zwrotka 2” in Polish.",
"- Edit slide text directly in the part's field. An empty line starts a new slide.",
"- + Section adds a part. Verse numbers are picked automatically.",
"- An empty part, such as an Instrumental with no words, is a blank slide for the band.",
"## Lines per slide for an existing song",
img("12-song-layout-bar", "Lines per slide"),
"You can change the layout of any song, including imported ones:",
"1. Choose 1 to 6 in Lines per slide.",
"2. Click Re-split.",
"All parts are split again. The order of lines and the part names stay the same. Part labels and repeat marks left inside the lyrics (for example, a Chorus x2 line in an imported song) are removed, and the repeats are written out.",
"## Saving",
"Changes are saved automatically about a second after you stop typing; the editor shows Saved. A new song is saved as soon as it has a title — until then the editor reminds you to type one. The Save button still works if you want to save at once.",
"## Duplicating a slide",
"Click a slide, press Ctrl+C, then Ctrl+V (Cmd on a Mac). The copy is placed right after the original. Useful for repeated lines.",
"## Collections",
"The list under the song title sets the collection. The library on the left groups songs by collection.",
"## Import and export",
img("14-songs-import-menu", "Import and export menu"),
table(["Button", "What it does"], [
    ["Import ProPresenter library", "Loads a whole ProPresenter 7 song folder, keeping its folder structure. Songs already in the library are skipped, so importing the folder again only adds what is new"],
    ["Import .pro", "One or more ProPresenter 7 songs, in the order of their arrangement (a chorus sung three times appears three times)"],
    ["Import song (JSON)", "A song exported from Bible Presenter"],
    ["Export this song", "A file for moving the song to another computer"],
]),
"## Showing a song",
"Click a slide to put it on the projector. The arrows and the clicker then move through the slides in order, from one part to the next.",
"Right-click a song in the library to delete it.",
"Deleting a part with the ✕ in its header asks first when the part has lyrics.",
])))

# ---------------------------------------------------------------- 05 presentations
A.append(("05-presentations", "Presentations", "🖥️", "\n\n".join([
img("17-presentations", "Presentations tab"),
"## Supported formats",
table(["Format", "What you need"], [
    [".pptx (PowerPoint)", "The free LibreOffice. Slides look exactly like the original"],
    [".pdf", "Nothing. Works out of the box"],
]),
"The top of the tab tells you whether LibreOffice was found.",
callout("💡", "blue_bg", "No LibreOffice? Save the presentation from PowerPoint or Keynote as PDF (File → Export → PDF) and import that. The result is the same."),
"## Importing",
"1. Click Import .pptx / .pdf at the bottom left.",
"2. Choose the file. The slides appear on the right.",
"Each slide is stored as a high-resolution image, so fonts and layout don't depend on the computer.",
"## Collections",
"The folder button next to a presentation opens the collection picker:",
img("18-collection-dialog", "Choosing a collection"),
"- choose an existing collection from the list;",
"- — No collection — removes it from its collection;",
"- + New collection… lets you type a new name.",
"## Showing a presentation",
"Click a slide to put it on the projector. The arrows and the clicker move on from there.",
"The trash button deletes the presentation.",
toggle("“This presentation was saved by an older version of the app”",
    "Very old versions stored presentations differently. Delete the presentation and import the file again."),
])))

# ---------------------------------------------------------------- 06 media
A.append(("06-media", "Media", "🖼️", "\n\n".join([
img("19-media", "Media tab"),
"Media are sets of photos and videos: announcements, title cards, event photos.",
"## Creating a set",
"1. Click + New media set.",
"2. Choose the files. You can select several at once.",
"3. The set is named automatically. To rename it, click the pencil next to the set in the list on the left.",
"To add files to the open set, click + Add to current set.",
table(["Type", "Formats"], [
    ["Images", "jpg, jpeg, png, webp, gif, bmp"],
    ["Video", "mp4, webm, mov, m4v"],
]),
"## Showing media",
"- Click a photo or video to put it on the projector.",
"- Videos carry a VIDEO label and play muted, on a loop.",
"- The + on a card adds it to the service playlist.",
"- The delete button in the card's corner removes the file from the set.",
"Photos and videos from Media are also available as song and theme backgrounds.",
])))

# ---------------------------------------------------------------- 07 backgrounds & themes
A.append(("07-backgrounds-and-themes", "Backgrounds and themes", "🎨", "\n\n".join([
"## Song backgrounds",
img("20-backgrounds-strip", "Song Backgrounds strip"),
"The Song Backgrounds tab in the bottom strip changes the background under the text during the service.",
"- Click a background to apply it on the projector at once. The text stays on screen.",
"- No background returns to the theme's background.",
"- + Add loads new photos or videos.",
"A video background does not restart when the slide changes.",
img("29-projector-song", "A song over a background"),
"## Projector themes",
"A theme sets how text looks on the projector: font, size, colors, background, alignment.",
img("21-themes-manager", "Projector Themes"),
"At the top you choose two active themes: one for the Bible and one for songs.",
"### Creating a theme",
"1. Click Themes on the top bar.",
"2. Click + Create.",
"3. Adjust the settings. The preview on the right updates as you go.",
"4. Click Save theme.",
img("22-theme-editor", "Theme editor"),
table(["Setting", "What it controls"], [
    ["Used for", "Bible and songs, Bible only, or songs only"],
    ["Font, size", "Any font installed on the computer"],
    ["Letter and line spacing", "How dense the text is"],
    ["Text color, background color", "The main colors"],
    ["Background image or video", "From the backgrounds and media library"],
    ["Background fit", "Fill screen (crop) or Fit entirely"],
    ["Alignment, capitals", "Text position and case"],
]),
"## Importing ProPresenter themes",
"In Projector Themes, click Import .proTheme. The font, weight, size, color, letter and line spacing, and outline carry over.",
"Import (JSON) and the export button in the editor move themes between computers running Bible Presenter.",
])))

# ---------------------------------------------------------------- 08 playlist
A.append(("08-service-playlist", "Service playlist", "📋", "\n\n".join([
img("23-playlist", "Service playlist"),
"The playlist is the whole service in order: verses, songs, presentations and media in one list. It is saved, so you can open it again next time.",
"## Creating a playlist",
"1. In the bottom strip, open the Service Playlist tab.",
"2. Click + New and type a name, for example Sunday Service.",
"## Adding items",
table(["To add", "How"], [
    ["A verse", "Pick the verse on the Bible tab, then + Verse in the playlist, or + To playlist under the preview"],
    ["A song", "Open the song, then + Song"],
    ["A presentation", "Open the presentation, then + Presentation"],
    ["A photo or video", "The + on its card in the Media tab"],
]),
"Every item shows an icon and its type: Bible, Song, Presentation, Media.",
"## Order and removal",
"- Drag an item to a new position.",
"- Right-click an item to remove it from the playlist. The song or presentation itself stays in the library.",
"- The arrow button at the top of the strip hides or shows the playlist, to give the work area more room.",
"## Running the service",
"1. Click the first item. It opens in its own tab, and nothing goes on screen yet.",
"2. Press Next on the clicker (or →). The first slide appears.",
"3. Keep pressing Next. At the end of a song, presentation or media item, Next opens the following item and shows its first slide, so the whole service runs from the clicker.",
"A verse item works the same way: the first Next shows the verse, and further presses read on through the chapter. To leave the Bible and move on, click the next item in the playlist.",
"## Playlist buttons",
table(["Button", "What it does"], [
    ["Playlist list", "Open a saved playlist"],
    ["+ New", "Create a playlist. Every change is saved on the spot"],
    ["⋯", "Import or export the playlist as a file, rename it, or delete it"],
]),
img("24-playlist-menu", "Playlist menu: import, export, rename, delete"),
"Export is handy for preparing a service at home and opening it on the church computer.",
callout("ℹ️", "blue_bg", "An exported playlist carries its songs inside the file: on import, songs the other computer doesn't have are added to its library. Presentations and media are not included — the import lists any that are missing, so you can import those files there too."),
])))

# ---------------------------------------------------------------- 09 projector & remote
A.append(("09-projector-and-clicker", "Projector, clearing and the clicker", "🕹️", "\n\n".join([
"## Putting things on the projector",
"- Bible: Show on screen, or double-click a verse in the search results.",
"- Songs, presentations, media: click a slide.",
img("05-projector-verse", "Projector"),
"## Clearing",
img("09-clear-bar", "Clear buttons"),
table(["Button", "When to use it"], [
    ["Text", "Instrumental or pause: the words go, background and video stay"],
    ["Screen", "You need a blank screen: sermon without slides, end of service"],
    ["Live output", "Remove the lower thirds from the stream only, leave the projector as it is"],
]),
"## Clicker and keyboard",
"Standard USB presentation clickers and the keyboard both work.",
table(["Key or clicker button", "Action"], [
    ["→  ↓  Page Down  Space", "Next slide or verse"],
    ["←  ↑  Page Up", "Previous slide or verse"],
    ["F5", "Bring the last slide back on screen"],
    ["Esc", "Clear the screen (with a window open, Esc closes the window instead)"],
    ["B, W or period", "Black out the screen, or bring the picture back"],
]),
callout("ℹ️", "blue_bg", "Keys work while the control window or the projector window is active. While you are typing in a field, the arrows move the cursor and don't change slides."),
"The clicker reads on without stopping: in a song it moves from part to part, in the Bible from the last verse of a chapter to the first verse of the next one, and on into the next book.",
"No clicker? A phone does the same job and shows what comes next — see Phone remote.",
])))

# ---------------------------------------------------------------- 10 live output
A.append(("10-live-output", "Live output to vMix and OBS", "📡", "\n\n".join([
"The app serves lower thirds as a web page. vMix and OBS add it as a browser source and put it over the camera.",
img("30-stream-view", "Lower third over the camera"),
"## Turning it on",
"1. Click Live output on the top bar.",
"2. Click Turn on. The default port is 7777.",
"3. Copy the address from Addresses for vMix.",
img("25-live-output", "Live output panel"),
"The vMix or OBS computer must be on the same network as the Bible Presenter computer. If it is the same computer, the 127.0.0.1 address works too.",
"## vMix",
"1. Add Input → Web Browser.",
"2. Paste the address and add ?transparent=1 at the end.",
"3. Set the size to match your output, for example 1920×1080.",
"## OBS",
"1. Sources → + → Browser.",
"2. Paste the address into URL with ?transparent=1 at the end.",
"3. Set width and height to match the scene, for example 1920×1080.",
callout("💡", "blue_bg", "?transparent=1 makes the page background transparent, so the lower third sits over the video. Without it the page draws its own background."),
"## Styling the lower thirds",
img("26-live-output-style", "Lower-third style"),
"Songs and verses are styled separately: switch between them at the top of Live output theme.",
table(["Group", "What you can set"], [
    ["Text", "Font, size, spacing, color, bold, capitals, shadow, outline"],
    ["Plate", "Background behind the text: under each line, one for the whole text, or full width"],
    ["Position", "Bottom or top, offsets, alignment"],
    ["Verse reference", "Whether to show it, where, and how large"],
]),
"Save settings as a theme, or load a ProPresenter theme (.proTheme).",
"Merge slide lines into one puts all lines of a slide in a single line on the stream. The round arrow next to the saved-theme list resets the style to the default black and white.",
"## Clearing the stream",
img("32-clear-stream-on", "Stream cleared"),
"The Live output button in the clear bar removes the lower thirds from the stream. The stream stays empty until you press the button again, even while slides change on the projector.",
"- Green dot — lower thirds are going out.",
"- Red dot — the stream is cleared.",
])))

# ---------------------------------------------------------------- 11 stage display
A.append(("11-stage-display", "Stage display", "🎤", "\n\n".join([
img("31-stage-display", "Stage display"),
"A separate page for musicians and the preacher: what is on screen now, what comes next, the clock and the service time.",
"## Connecting",
"1. Turn on live output: Live output → Turn on.",
"2. Open the Stage display group and copy the address.",
"3. Open the address in a browser on a tablet, phone or laptop on the same network. Nothing to install.",
img("27-stage-settings", "Stage display settings"),
"## Settings",
table(["Setting", "Options"], [
    ["Layout", "Current + next, Current + clock, Current only"],
    ["Clock", "Current time"],
    ["Service timer", "Time since live output was turned on, the same on every device"],
    ["12-hour clock (AM/PM)", "Time in AM/PM format"],
    ["Text size", "Scales the whole display"],
]),
"The stage display follows the projector, not the stream: holding the live output clear does not blank it. At the end of a playlist item the next line shows what comes next in the service.",
"The current slide is shown in yellow, the next one below it in white. To start the timer from zero when the service begins, click Reset next to Service timer: every stage device resets at once.",
callout("💡", "blue_bg", "Open the page full screen: press F11 in a desktop browser; on an iPad use Share → Add to Home Screen."),
])))

# ---------------------------------------------------------------- 12 phone remote
A.append(("12-phone-remote", "Phone remote", "📱", "\n\n".join([
img("33-phone-remote", "The remote on a phone: a presentation on screen, the next slide beside it, and the slides below"),
"Any smartphone or tablet can drive the service: step through slides, clear the text, black out the screen, pick what comes next and open any presentation from the library. Nothing comes from an app store — the remote is a page the app itself serves on your network, so it works the same on iPhone and Android.",
"## Connecting",
"1. Click Remote in the top bar, then Turn on.",
"2. Point the phone's camera at the QR code and open the link. The phone is connected at once.",
"3. No camera at hand? Type the address shown under the QR code into the phone's browser and enter the 6-digit PIN.",
img("34-remote-panel", "Remote panel in the app"),
callout("⚠️", "yellow_bg", "The phone and the computer must be on the same Wi-Fi network. The first time, Windows may ask whether Bible Presenter may use the network — allow it on private networks."),
"## Make it an app on the phone",
"- iPhone or iPad: in Safari tap Share → Add to Home Screen.",
"- Android: in Chrome tap ⋮ → Add to Home screen (or Install app).",
"The icon opens the remote in one tap; on iPhone and iPad it opens full screen, without the browser bars. If it asks for the PIN, type it once.",
callout("💡", "blue_bg", "Phones lock their screen after a minute or so. For the service, set Auto-Lock (iPhone) or Screen timeout (Android) to a longer time, so the remote is ready when you need it."),
"## Using the remote",
table(["On the phone", "What it does"], [
    ["On screen", "What the room sees right now. For presentations and pictures it is the slide itself, with the next slide beside it, and the counter shows which slide of how many. Shows Screen is off in red while the projector is blacked out"],
    ["Next", "The slide that the Next button will show"],
    ["Next, Back", "The same as a clicker. At the end of a playlist item, Next opens the following item and shows its first slide"],
    ["Clear text", "Removes the words; the background keeps playing"],
    ["Hide screen, Show screen", "Blacks out the projector, then brings the last slide back"],
    ["Slides tab", "The slides of the current item: text for songs and verses, pictures for presentations and media. Tap one to put it on screen. The slide on screen is green, the one Next will show is yellow"],
    ["Service tab", "The service plan. Tap an item to get it ready, then press Next"],
    ["Presentations tab", "Every presentation in the library, grouped by collection, with a search box when there are many. Tap one to get it ready, then press Next or tap a slide"],
    ["List at the top", "Switches to another saved service"],
]),
"The phone follows the app: whatever the operator does at the computer shows up on the phone at once, and the other way round. Two people can work together — one at the computer, one with the phone.",
"## Access",
"Only paired phones can control the app: the QR code carries a private key, and the PIN is the manual way in. To take access away from every phone (a borrowed phone, a volunteer who has left), click Reset access. All phones are disconnected, and a new PIN and QR code are made.",
"If the remote was on when you closed the app, it turns itself back on the next time. It uses port 7780; change the port if another program already uses it.",
callout("💡", "blue_bg", "Give the computer a fixed address in the router (a DHCP reservation). Then the home-screen icon keeps working week after week. If the address does change, scan the QR code again."),
])))

# ---------------------------------------------------------------- 13 hotkeys
A.append(("13-keyboard-shortcuts", "Keyboard shortcuts", "⌨️", "\n\n".join([
table(["Keys", "Action", "Where"], [
    ["→  ↓  Page Down  Space", "Next slide or verse", "Everywhere"],
    ["←  ↑  Page Up", "Previous slide or verse", "Everywhere"],
    ["F5", "Bring the last slide back on screen", "Everywhere"],
    ["Esc", "Clear the screen", "When no window is open"],
    ["B, W, period", "Black out the screen or bring it back", "Everywhere"],
    ["Enter", "Jump to a reference or search for a phrase", "Bible search field"],
    ["Ctrl+C, then Ctrl+V", "Duplicate a slide", "Song editor"],
    ["Enter, Esc", "OK or Cancel; Esc closes any open window without touching the screen", "Dialogs"],
]),
"On a Mac, use Cmd instead of Ctrl.",
callout("ℹ️", "blue_bg", "While you type in a field, the arrows and Space behave normally and don't change slides."),
])))

# ---------------------------------------------------------------- 14 data & updates
A.append(("14-data-backups-and-updates", "Data, backups and updates", "🗂️", "\n\n".join([
"## Where your data lives",
"Songs, Bible translations, presentations, media, backgrounds, themes and playlists are stored in your user folder, not in the program folder:",
table(["System", "Folder"], [
    ["Windows", "%APPDATA%\\BiblePresenter"],
    ["macOS", "~/Library/Application Support/BiblePresenter"],
]),
"The exact path is shown in the settings menu. Reinstalling or updating the app does not touch this folder.",
"## Backing up",
"1. Close the app.",
"2. Copy the whole BiblePresenter folder to a USB drive or cloud storage.",
"To move everything to another computer, install the app there, close it, and replace its BiblePresenter folder with your copy.",
callout("💡", "blue_bg", "Make a backup before big changes, such as importing a whole ProPresenter library."),
"## Updates",
"- A few seconds after launch, the app checks for a new version.",
"- If there is one, it downloads in the background without interrupting you.",
"- The app then offers to restart. Later is the default, so an update never interrupts a service. The new version installs the next time you close the app.",
"- To check by hand: settings → Check for updates.",
])))

# ---------------------------------------------------------------- 15 troubleshooting
A.append(("15-troubleshooting", "Troubleshooting", "🛠️", "\n\n".join([
toggle("The projector window opened on the main screen",
    "Make sure the projector is set to Extend these displays (Windows) or that mirroring is off (macOS). If you connected the projector after launch, wait a couple of seconds for the window to move. If it doesn't, restart the app."),
toggle("The clicker doesn't change slides",
    "Click the control window so it is active. If the cursor is in a text field, the arrows move the cursor — click an empty area. Check that the clicker sends arrow keys, Page Up/Page Down or Space."),
toggle("A .pptx file won't import",
    "Install the free LibreOffice (libreoffice.org) and restart the app. The top of the Presentations tab should say LibreOffice was found. Or save the presentation as PDF and import that."),
toggle("A PDF won't import",
    "“The PDF is password-protected” — save the PDF again without a password. “The file is damaged or is not a PDF” — export the file again from the original program."),
toggle("“This build of the app is incomplete”",
    "The installer was built without the slide rendering module. Download and install the latest version."),
toggle("vMix or OBS doesn't show the lower thirds",
    "Check that live output is on (green dot on the Live output button). Both computers must be on the same network. The first time, Windows Firewall may ask for permission — allow access on private networks. Also check the stream isn't cleared (red dot)."),
toggle("The stage display is empty",
    "Nothing is on the projector yet. Put any slide on screen and it appears on the stage display at once."),
toggle("The phone can't open the remote",
    "Check that the phone is on the same Wi-Fi as the computer — not on mobile data, and not on a guest network that keeps devices apart. The first time, allow Bible Presenter through Windows Firewall on private networks. If the computer is connected to several networks, choose the one the phone uses under Network in the Remote panel."),
toggle("A reference opens the wrong book",
    "Use standard abbreviations (Jn, Mt, Ps, Rev) or the full name. For the books of Kings, numbering depends on the translation — see Bible."),
toggle("macOS says the app can't be opened",
    "First launch: right-click the app → Open → Open (macOS 15 and later: System Settings → Privacy & Security → Open Anyway). After that it opens normally."),
toggle("Songs or translations are missing",
    "Your data lives in your user folder (see Data, backups and updates). If you reinstalled the system or moved to a new computer, restore the BiblePresenter folder from your backup."),
])))

# ================================================================= writers
def to_plain(md):
    """Enhanced Markdown -> plain Markdown for Notion's file importer."""
    def cal(m):
        icon = m.group(1)
        lines = [l.strip() for l in m.group(2).strip("\n").split("\n")]
        return "\n".join(f"> {icon} {l}" if i == 0 else f"> {l}" for i, l in enumerate(lines))
    md = re.sub(r'<callout icon="([^"]+)" color="[^"]+">\n(.*?)\n</callout>', cal, md, flags=re.S)
    def det(m):
        lines = [l.strip() for l in m.group(2).strip("\n").split("\n")]
        return f"**{m.group(1)}**\n\n" + "\n\n".join(lines)
    md = re.sub(r"<details>\n<summary>(.*?)</summary>\n(.*?)\n</details>", det, md, flags=re.S)
    def tab(m):
        rows = re.findall(r"<tr>(.*?)</tr>", m.group(0), flags=re.S)
        cells = [[c.strip() for c in re.findall(r"<td>(.*?)</td>", r, flags=re.S)] for r in rows]
        out = ["| " + " | ".join(cells[0]) + " |", "|" + "---|" * len(cells[0])]
        out += ["| " + " | ".join(r) + " |" for r in cells[1:]]
        return "\n".join(out)
    md = re.sub(r'<table header-row="true">.*?</table>', tab, md, flags=re.S)
    return md.replace("{{IMG}}/", "images/")

def escape_enhanced(md):
    """Escape characters the enhanced format treats as markup, in text only.
    Tag lines (<callout>, <td>…) keep their markup; image syntax stays intact."""
    out = []
    for line in md.split("\n"):
        # protect ![caption](url) and [text](url) links
        keep = {}
        def stash(m):
            k = f"\x00{len(keep)}\x00"; keep[k] = m.group(0); return k
        line = re.sub(r"!?\[[^\]]*\]\([^)]*\)", stash, line)
        # protect our own tags so their < > stay tags
        line = re.sub(r"</?(callout|details|summary|table|tr|td)\b[^>]*>", stash, line)
        line = line.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("~", "\\~")
        for k, v in keep.items():
            line = line.replace(k, v)
        out.append(line)
    return "\n".join(out)

def main():
    ndir = os.path.join(HERE, "notion"); idir = os.path.join(HERE, "import")
    for d in (ndir, idir):
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    shutil.copytree(os.path.join(HERE, "images"), os.path.join(idir, "images"))
    order = []
    for slug, title, emoji, body in A:
        md = f"# {title}\n\n{body}\n"
        open(os.path.join(ndir, slug + ".md"), "w", encoding="utf-8").write(escape_enhanced(md))
        open(os.path.join(idir, slug + ".md"), "w", encoding="utf-8").write(to_plain(md))
        order.append({"file": slug + ".md", "title": title, "icon": emoji})
    import json
    json.dump(order, open(os.path.join(ndir, "order.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    used = set(re.findall(r"\{\{IMG\}\}/([\w-]+)\.png", "".join(b for *_, b in A)))
    have = {f[:-4] for f in os.listdir(os.path.join(HERE, "images"))}
    print(f"{len(A)} articles; images used {len(used)}; missing {sorted(used - have)}; unused {sorted(have - used)}")

if __name__ == "__main__":
    main()
