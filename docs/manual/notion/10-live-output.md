# Live output to vMix and OBS

The app serves lower thirds as a web page. vMix and OBS add it as a browser source and put it over the camera.

![Lower third over the camera]({{IMG}}/30-stream-view.png)

## Turning it on

1. Click Live output on the top bar.

2. Click Turn on. The default port is 7777.

3. Copy the address from Addresses for vMix.

![Live output panel]({{IMG}}/25-live-output.png)

The vMix or OBS computer must be on the same network as the Bible Presenter computer. If it is the same computer, the 127.0.0.1 address works too.

## vMix

1. Add Input → Web Browser.

2. Paste the address and add ?transparent=1 at the end.

3. Set the size to match your output, for example 1920×1080.

## OBS

1. Sources → + → Browser.

2. Paste the address into URL with ?transparent=1 at the end.

3. Set width and height to match the scene, for example 1920×1080.

<callout icon="💡" color="blue_bg">
	?transparent=1 makes the page background transparent, so the lower third sits over the video. Without it the page draws its own background.
</callout>

## Styling the lower thirds

![Lower-third style]({{IMG}}/26-live-output-style.png)

Songs and verses are styled separately: switch between them at the top of Live output theme.

<table header-row="true">
	<tr>
		<td>Group</td>
		<td>What you can set</td>
	</tr>
	<tr>
		<td>Text</td>
		<td>Font, size, spacing, color, bold, capitals, shadow, outline</td>
	</tr>
	<tr>
		<td>Plate</td>
		<td>Background behind the text: under each line, one for the whole text, or full width</td>
	</tr>
	<tr>
		<td>Position</td>
		<td>Bottom or top, offsets, alignment</td>
	</tr>
	<tr>
		<td>Verse reference</td>
		<td>Whether to show it, where, and how large</td>
	</tr>
</table>

Save settings as a theme, or load a ProPresenter theme (.proTheme).

## Clearing the stream

![Stream cleared]({{IMG}}/32-clear-stream-on.png)

The Live output button in the clear bar removes the lower thirds from the stream. The stream stays empty until you press the button again, even while slides change on the projector.

- Green dot — lower thirds are going out.

- Red dot — the stream is cleared.
