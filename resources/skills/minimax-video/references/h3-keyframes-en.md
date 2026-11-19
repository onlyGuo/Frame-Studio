# H3 text and keyframe modes

## Select the input mode

- T2VA. Describe the opening composition and action in temporal order. Begin directly with the main integrated description.
- I2VA. Start from the actual first image at 0.00 s. Preserve its composition, subject placement, identity and costume. Describe the movement that develops from it. The host emits the alignment header.
- FL2VA. In an adapter that accepts both keyframes, align the opening picture to 0.00 s and the other to the effective duration, written with two decimals. Describe observable transitional states, keeping the composition and objects coherent. Let the final pose settle into the supplied ending.
- L2VA. In an adapter that accepts an ending image, establish a plausible prior state and describe how the action reaches the last image at the end. Do not describe the end image as the opening.

The Frame Studio board currently supplies T2VA and I2VA for these modes.

## Assemble the three sections

1. `integrated_multimodal_description` begins with `[Shot 1]`, followed by framing, visible environment, participants, acting and camera direction. When a cut is specified, number it sequentially and place a timestamp such as `[Shot 2] At 00:04.200` inside the requested duration. Camera directions should describe movement, its speed and the amount of travel. Use the approved on-screen text in quotation marks, in its own language.
2. `overall_soundscape` records only ambience and physical sounds supported by the shot. Distinguish sounds made in the frame from off-camera sound. There is no need to restate speech here.
3. `non_diegetic_music` describes requested music heard only by the audience. If the shot does not request music, enter `N/A`.

## Speech and timing

The host inserts literal spoken text using the H3 dialogue tag and places the named speaker or narrator outside it. Keep the placeholder where speech belongs in the action. Off-screen narration is identified separately from a visual character with moving lips. For dialogue crossing a cut, describe continuity only when that continuity is explicitly part of the same locked clip. Use a neutral environmental description for unspoken action notes.

Example. In an approved shot showing rain hitting an empty pier, open with a static wide shot and describe the rain against the water, then an existing lamp's light in the wet boards. The atmosphere has water and rain, no intelligible voices, and no score.
