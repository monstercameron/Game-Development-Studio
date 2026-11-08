// Help for the Vegetation page. The keys are the visible label texts. Control labels come from
// SeedThree's own control names, so each name it uses is described here; a control that has no
// entry still shows its range and default under the field.
const vegetation = {
  'Describe the plant':
    'Type what you want, such as “an old windswept pine with a thin crown”. A language model suggests a species, a seed and control values. You always see them as normal controls first; nothing is queued until you press Add to queue.',
  Species:
    'The kind of plant SeedThree grows. Each species has its own shape controls. Changing species resets the controls you tuned.',
  Seed: 'A whole number from 1 to 9999. The same species, seed and settings always give the same plant; another seed is another individual of the species.',
  Variations:
    'Queue 1 to 4 plants at once. They use consecutive seeds starting from the seed above, and are shown as Variation 1 of N.',
  'Triangle budget':
    'Which level of detail is exported. SeedThree builds three: the most detailed has the most triangles. The counts shown are measured for the default design of the species.',
  // Headline shape controls.
  'Height (m)': 'Overall height of the plant in metres before randomness is applied.',
  'Branch levels':
    'How many generations of branching the plant has. More levels add fine twigs and many more triangles; at the maximum some species lose their leaves.',
  'Crown shape': 'The overall outline of the crown, such as conical, spherical or flame-shaped.',
  'Branch density': 'How many branches grow from the trunk and limbs. Higher values are bushier.',
  'Branch angle': 'How far branches spread away from the trunk, in degrees.',
  Gnarliness: 'How twisted and bent the limbs are. Higher values look older and more weathered.',
  Trunks: 'How many main trunks the plant has.',
  'Trunk thickness': 'Scales the thickness of the trunk and main limbs.',
  'Leaf size': 'Scales every leaf or needle spray.',
  'Leaves / branch': 'How many leaves grow on each twig. More leaves add triangles.',
  'Show leaves': 'Turn off to export the bare branches only.',
  'Leaf angle': 'How far leaves hang away from their twig, in degrees.',
  'Leaf start': 'How far along each twig the leaves begin, from the base (0) to the tip (1).',
  'Leaf size variance': 'How much leaf sizes differ from each other.',
  'Leaf billboard':
    'Single uses one card per leaf; Crossed uses two crossing cards, which looks fuller from any side and uses more triangles.',
  'Primary scaffolds': 'Number of main limbs that leave the trunk.',
  'Crown spread': 'How wide the crown grows compared with its height.',
  'Feeder spacing (m)': 'Distance between the small feeding branches.',
  'Vine spacing (m)': 'Distance between the hanging vines.',
  'Vine length (m)': 'Length of the hanging vines.',
  'Trunk height (m)': 'Height of the bare trunk before it branches.',
  'Arm length (m)': 'Length of each arm or segment.',
  'Fork generations': 'How many times the stems fork. More generations are denser and heavier.',
  Branchiness: 'How likely a stem is to fork.',
  'Fork spread (°)': 'How far forks spread apart, in degrees.',
  'Arm bend (°)': 'How strongly arms bend, in degrees.',
  'Arm curl-up': 'How much arms curve upwards.',
  'Trunks (rare >1)': 'How many trunks grow from the base; more than one is rare in nature.',
  'Rosette size': 'Size of the leaf rosettes at the tips.',
  'Rosette variation': 'How much rosette size varies.',
  'Column growth (m/seg)': 'How much taller the column grows with each segment.',
  'Column segments': 'How many segments the column has. More segments are taller and heavier.',
  'Arm frequency': 'How often arms grow from the column.',
  'Arm splay (°)': 'How far arms spread out from the column, in degrees.',
  Ribs: 'Number of ribs around the column.',
  'Rib depth': 'How deep the grooves between ribs are.',
  'Column thickness': 'Scales the thickness of the column.',
  'Spine density': 'How many spines cover the plant. Fewer spines mean fewer triangles.',
  'Stems from crown': 'Number of stems that grow from the root crown.',
  'Stem splay (°)': 'How far stems lean away from each other, in degrees.',
  'Segment length (m)': 'Length of each stem segment.',
  'Sprays per twig': 'Number of leaf sprays on each twig.',
  'Spray size': 'Size of each leaf spray.',
  Upsweep: 'How much stems curve upwards.',
};

// Advanced controls repeat per branching level, as “Name · L1”, “Name · L2”.
const advanced = {
  'Down angle': 'Angle between a branch and its parent, in degrees.',
  Children: 'How many child branches grow from each branch of this level.',
  Gnarliness: 'How twisted branches of this level are.',
  Curve: 'How much branches of this level curve along their length.',
  'Length ×': 'Length of branches of this level, relative to the level above.',
  Taper: 'How quickly branches of this level thin towards their tip.',
  Twist: 'How much branches of this level twist around their axis.',
  Sections: 'How many pieces each branch of this level is divided into for curving.',
  Segments: 'How many sides the tube of this level has. More sides are rounder and heavier.',
};
for (const [name, text] of Object.entries(advanced)) {
  for (const level of [0, 1, 2, 3]) {
    vegetation[`${name} · L${level}`] = text;
  }
}
Object.assign(vegetation, {
  'Force dir X': 'Sideways direction that growth is pulled towards.',
  'Force dir Y': 'Up or down direction that growth is pulled towards.',
  'Force dir Z': 'Front to back direction that growth is pulled towards.',
  'Force strength': 'How strongly growth is pulled in that direction, such as wind-bent trees.',
  'Arm falloff / gen': 'How much shorter each generation of arms is.',
  'Trident chance': 'Chance that a fork splits into three arms instead of two.',
  'Arm thickness keep': 'How much of its thickness an arm keeps when it forks.',
  'Arm base neck': 'Thickness of the neck where an arm joins the column.',
  'Branch repel': 'How strongly branches push away from each other to avoid crossing.',
  'Trunk base flare': 'How much the trunk widens at the ground.',
  'Trunk ring detail': 'Number of sides around the trunk. More sides are rounder and heavier.',
  'Multi-trunk splay (°)': 'How far multiple trunks lean apart, in degrees.',
  'Arm style': 'Candelabra arms grow unevenly; symmetric V arms grow in matched pairs.',
  'Arm min height': 'How far up the column the first arm may start.',
  'Arm max order': 'How many generations of arms can grow from arms.',
  'Arm length (segments)': 'How many segments an arm has.',
  '2-arm chance': 'Chance that a fork makes two arms instead of one.',
  'Column ring detail': 'Number of sides around the column. More sides are rounder and heavier.',
});

export default vegetation;
