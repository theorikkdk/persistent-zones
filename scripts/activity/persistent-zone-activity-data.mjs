import {
  ACTIVITY_DEFINITION_FIELD_KEY,
  ACTIVITY_DEFINITION_SCHEMA_VERSION
} from "../constants.mjs";

export class PersistentZoneActivityData extends dnd5e.dataModels.activity.BaseActivityData {
  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    if (schema.target?.fields?.prompt?.options) {
      schema.target.fields.prompt.options.initial = true;
    }

    return {
      ...schema,
      [ACTIVITY_DEFINITION_FIELD_KEY]: new fields.SchemaField({
        schemaVersion: new fields.NumberField({
          integer: true,
          required: false,
          initial: ACTIVITY_DEFINITION_SCHEMA_VERSION
        }),
        enabled: new fields.BooleanField({
          required: false,
          initial: true
        }),
        geometry: new fields.SchemaField({
          type: new fields.StringField({
            required: false,
            initial: "circle",
            choices: ["circle", "rectangle", "ring", "wall"]
          }),
          radius: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 10,
            min: 0
          }),
          width: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 10,
            min: 0
          }),
          height: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 10,
            min: 0
          }),
          units: new fields.StringField({
            required: false,
            initial: "scene",
            choices: ["scene", "ft", "m"]
          }),
          placement: new fields.StringField({
            required: false,
            initial: "center",
            choices: ["center"]
          }),
          ringReferenceRadius: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 10,
            min: 0
          }),
          ringInnerWidth: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 5,
            min: 0
          }),
          ringOuterWidth: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 0,
            min: 0
          }),
          wallLength: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 30,
            min: 0
          }),
          wallThickness: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 5,
            min: 0
          }),
          referenceRadiusMode: new fields.StringField({
            required: false,
            initial: "outer-edge",
            choices: ["outer-edge", "centerline", "inner-edge"]
          })
        }),
        parts: new fields.ArrayField(new fields.ObjectField(), {
          required: false
        }),
        triggers: new fields.SchemaField({
          enter: createTriggerSchema(fields, true, false),
          move: createTriggerSchema(fields, false, false),
          exit: createTriggerSchema(fields, false, true),
          turnStart: createTriggerSchema(fields, false, false),
          turnEnd: createTriggerSchema(fields, false, false),
          onCreate: createTriggerSchema(fields, false, false),
          onEnter: createTriggerSchema(fields, false, false),
          onExit: createTriggerSchema(fields, false, true),
          onMove: createTriggerSchema(fields, false, false),
          onStartTurn: createTriggerSchema(fields, false, false),
          onEndTurn: createTriggerSchema(fields, false, false)
        }),
        save: createSaveSchema(fields),
        damage: createDamageSchema(fields),
        effects: new fields.SchemaField({
          enabled: new fields.BooleanField({
            required: false,
            initial: false
          })
        }),
        movement: new fields.SchemaField({
          stopOnTrigger: new fields.BooleanField({
            required: false,
            initial: false
          }),
          stopMode: new fields.StringField({
            required: false,
            initial: "on-enter",
            choices: ["off", "on-enter", "on-enter-and-move"]
          }),
          movementMode: new fields.StringField({
            required: false,
            initial: "any",
            choices: ["any", "voluntary", "forced"]
          }),
          stepMode: new fields.StringField({
            required: false,
            initial: "distance",
            choices: ["distance", "grid-cell"]
          }),
          distanceStep: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 5,
            min: 0
          }),
          cellStep: new fields.NumberField({
            integer: true,
            required: false,
            nullable: true,
            initial: 1,
            min: 1
          })
        }),
        terrain: new fields.SchemaField({
          enabled: new fields.BooleanField({
            required: false,
            initial: false
          }),
          multiplier: new fields.NumberField({
            required: false,
            nullable: true,
            initial: 2,
            min: 1
          })
        }),
        linkedWalls: new fields.SchemaField({
          enabled: new fields.BooleanField({
            required: false,
            initial: false
          }),
          preset: new fields.StringField({
            required: false,
            initial: "solid"
          }),
          geometry: new fields.StringField({
            required: false,
            initial: "centerline",
            choices: ["centerline", "perimeter"]
          }),
          move: new fields.StringField({required: false, initial: "normal", choices: ["none", "normal"]}),
          sight: new fields.StringField({required: false, initial: "normal", choices: ["none", "limited", "normal", "proximity", "distance"]}),
          light: new fields.StringField({required: false, initial: "normal", choices: ["none", "limited", "normal", "proximity", "distance"]}),
          sound: new fields.StringField({required: false, initial: "normal", choices: ["none", "limited", "normal", "proximity", "distance"]}),
          dir: new fields.StringField({required: false, initial: "both", choices: ["both", "left", "right"]}),
          threshold: new fields.SchemaField({
            sight: new fields.NumberField({required: false, nullable: true, initial: null, positive: true}),
            light: new fields.NumberField({required: false, nullable: true, initial: null, positive: true}),
            sound: new fields.NumberField({required: false, nullable: true, initial: null, positive: true}),
            attenuation: new fields.BooleanField({required: false, initial: false})
          }),
          height: new fields.NumberField({
            required: false,
            nullable: true,
            initial: null,
            min: 0
          })
        }),
        linkedLights: new fields.SchemaField({
          enabled: new fields.BooleanField({
            required: false,
            initial: false
          }),
          preset: new fields.StringField({
            required: false,
            initial: "glow"
          }),
          bright: new fields.NumberField({
            required: false,
            nullable: true,
            initial: null,
            min: 0
          }),
          dim: new fields.NumberField({
            required: false,
            nullable: true,
            initial: null,
            min: 0
          }),
          max: new fields.NumberField({
            integer: true,
            required: false,
            nullable: true,
            initial: 24,
            min: 1
          }),
          color: new fields.StringField({
            required: false,
            nullable: true,
            initial: "#ffd88a"
          })
        }),
        lifecycle: new fields.SchemaField({
          useDedicatedOwnerEffect: new fields.BooleanField({
            required: false,
            initial: true
          })
        })
      })
    };
  }

  static transformTypeData(source, activityData, options) {
    return foundry.utils.mergeObject(activityData, {
      target: {
        override: true,
        prompt: true,
        template: {
          type: "circle",
          size: source.system?.target?.value ?? 10,
          width: "",
          units: source.system?.target?.units ?? "ft"
        }
      }
    }, { inplace: false });
  }
}

function createTriggerSchema(fields, enabledInitial, exitTrigger) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: enabledInitial
    }),
    mode: new fields.StringField({
      required: false,
      initial: enabledInitial ? "simple-effect" : "none",
      choices: ["none", "simple-effect", "linked-activity", "simple", "activity"]
    }),
    targetFilter: new fields.SchemaField({
      mode: new fields.StringField({
        required: false,
        initial: "all",
        choices: ["all", "allies", "enemies", "self", "others"]
      })
    }),
    frequency: new fields.StringField({
      required: false,
      initial: "unlimited",
      choices: ["unlimited", "once-per-turn"]
    }),
    frequencyGroup: new fields.StringField({
      required: false,
      initial: ""
    }),
    requiredAbsentStatuses: new fields.ArrayField(new fields.StringField(), {
      required: false,
      initial: []
    }),
    simpleEffect: new fields.SchemaField({
      damage: createDamageSchema(fields),
      healing: createHealingSchema(fields),
      temporaryHitPoints: createTemporaryHitPointsSchema(fields),
      save: createSaveSchema(fields),
      statuses: createStatusesSchema(fields, exitTrigger)
    }),
    linkedActivity: new fields.SchemaField({
      id: new fields.StringField({
        required: false,
        nullable: true,
        initial: null
      }),
      uuid: new fields.StringField({
        required: false,
        nullable: true,
        initial: null
      })
    })
  });
}

function createDamageSchema(fields) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: false
    }),
    formula: new fields.StringField({
      required: false,
      initial: "1d6"
    }),
    type: new fields.StringField({
      required: false,
      initial: "fire"
    })
  });
}

function createHealingSchema(fields) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: false
    }),
    formula: new fields.StringField({
      required: false,
      initial: "1d6"
    })
  });
}

function createTemporaryHitPointsSchema(fields) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: false
    }),
    formula: new fields.StringField({
      required: false,
      initial: "1d6"
    })
  });
}

function createSaveSchema(fields) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: false
    }),
    ability: new fields.StringField({
      required: false,
      initial: "dex"
    }),
    dcMode: new fields.StringField({
      required: false,
      initial: "inherit",
      choices: ["auto", "inherit", "manual"]
    }),
    dc: new fields.NumberField({
      required: false,
      nullable: true,
      initial: 13,
      min: 1
    }),
    onSave: new fields.StringField({
      required: false,
      initial: "half",
      choices: ["none", "half"]
    })
  });
}

function createStatusesSchema(fields, exitTrigger) {
  return new fields.SchemaField({
    enabled: new fields.BooleanField({
      required: false,
      initial: false
    }),
    statusId: new fields.StringField({
      required: false,
      nullable: true,
      initial: null
    }),
    persistenceMode: new fields.StringField({
      required: false,
      initial: exitTrigger ? "persistent" : "persistent",
      choices: exitTrigger ? ["persistent"] : ["persistent", "while-inside-region"]
    }),
    recovery: new fields.SchemaField({
      mode: new fields.StringField({
        required: false,
        initial: "none",
        choices: ["none", "save-start-turn", "save-end-turn"]
      }),
      ability: new fields.StringField({
        required: false,
        nullable: true,
        initial: null
      }),
      dcMode: new fields.StringField({
        required: false,
        initial: "inherit",
        choices: ["inherit", "custom"]
      }),
      customDC: new fields.NumberField({
        required: false,
        nullable: true,
        initial: null,
        min: 1
      }),
      removeOnSuccess: new fields.BooleanField({
        required: false,
        initial: true
      }),
      provider: new fields.StringField({
        required: false,
        initial: "auto",
        choices: ["auto", "midi", "native"]
      }),
      effectFamilyId: new fields.StringField({
        required: false,
        nullable: true,
        initial: null
      }),
      potency: new fields.SchemaField({
        comparatorId: new fields.StringField({
          required: false,
          nullable: true,
          initial: null
        }),
        value: new fields.NumberField({
          required: false,
          nullable: true,
          initial: null
        }),
        comparable: new fields.BooleanField({
          required: false,
          initial: false
        })
      })
    })
  });
}
