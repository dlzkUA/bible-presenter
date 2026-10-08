# Songs

![Song editor]({{IMG}}/10-songs-editor.png)

The song library, grouped by collection, is on the left; the editor for the selected song is on the right. Each part of the song (verse, chorus) has its own color.

## A new song from existing lyrics

1. Click Paste lyrics.

2. Paste the lyrics.

3. Choose how many lines go on each slide.

4. Click Create slides.

![Pasting lyrics]({{IMG}}/15-paste-dialog.png)

![Result: parts and slides]({{IMG}}/16-paste-result.png)

The app splits the text into parts and slides by itself:

- Headings are recognised in any form: \[Verse 1\], Chorus:, CHORUS, Refrain, Estribillo — in 8 languages.

- Without headings, the repeated block becomes the chorus and the rest become verses.

- Your own labels, such as Interlude, are kept as written.

- Repeat marks are understood and removed from the slides: Chorus x2, 2x Chorus, Chorus (2 times), a line ending in (x2), a separate (x2) line under a block, / … / x2 and ||: … :||. The part or line is repeated as many times as written.

- A heading with no words under it, such as a second Chorus after verse 2, reuses the words that part had earlier.

- Instrumental breaks are recognised in any form: Instrumental, Interlude, Instrumental (guitar), --- Interlude ---. They become a blank slide.

- Numbered hymn verses (1. Amazing grace…) become Verse 1, Verse 2…; a lone title line at the top and an End line at the bottom are left out.

- Long lines are wrapped so the text stays readable on screen.

<callout icon="💡" color="blue_bg">
	You can also paste into a song that is already open: the new parts are added at the end.
</callout>

## Song parts

![Song parts]({{IMG}}/11-song-sections.png)

- Pick the part type in its header: Verse, Chorus, Pre-Chorus, Bridge, Tag, Intro, Instrumental, Outro.

- Part names follow the interface language: “Verse 2” in English, “Zwrotka 2” in Polish.

- Edit slide text directly in the part's field. An empty line starts a new slide.

- + Section adds a part. Verse numbers are picked automatically.

- An empty part, such as an Instrumental with no words, is a blank slide for the band.

## Lines per slide for an existing song

![Lines per slide]({{IMG}}/12-song-layout-bar.png)

You can change the layout of any song, including imported ones:

1. Choose 1 to 6 in Lines per slide.

2. Click Re-split.

All parts are split again. The order of lines and the part names stay the same. Part labels and repeat marks left inside the lyrics (for example, a Chorus x2 line in an imported song) are removed, and the repeats are written out.

## Saving

Changes are saved automatically about a second after you stop typing; the editor shows Saved. A new song is saved as soon as it has a title — until then the editor reminds you to type one. The Save button still works if you want to save at once.

## Duplicating a slide

Click a slide, press Ctrl+C, then Ctrl+V (Cmd on a Mac). The copy is placed right after the original. Useful for repeated lines.

## Collections

The list under the song title sets the collection. The library on the left groups songs by collection.

## Import and export

![Import and export menu]({{IMG}}/14-songs-import-menu.png)

<table header-row="true">
	<tr>
		<td>Button</td>
		<td>What it does</td>
	</tr>
	<tr>
		<td>Import ProPresenter library</td>
		<td>Loads a whole ProPresenter 7 song folder, keeping its folder structure. Songs already in the library are skipped, so importing the folder again only adds what is new</td>
	</tr>
	<tr>
		<td>Import .pro</td>
		<td>One or more ProPresenter 7 songs, in the order of their arrangement (a chorus sung three times appears three times)</td>
	</tr>
	<tr>
		<td>Import song (JSON)</td>
		<td>A song exported from Bible Presenter</td>
	</tr>
	<tr>
		<td>Export this song</td>
		<td>A file for moving the song to another computer</td>
	</tr>
</table>

## Showing a song

Click a slide to put it on the projector. The arrows and the clicker then move through the slides in order, from one part to the next.

Right-click a song in the library to delete it.

Deleting a part with the ✕ in its header asks first when the part has lyrics.
