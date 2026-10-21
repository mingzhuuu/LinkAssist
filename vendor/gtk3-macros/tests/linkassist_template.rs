use gtk::{glib, prelude::*, subclass::prelude::*};

mod imp {
    use super::*;

    #[derive(Debug, Default, gtk3_macros::CompositeTemplate)]
    #[template(string = "<interface><template class='LinkAssistMacroTest' parent='GtkBox'><child><object class='GtkLabel' id='label'/></child></template></interface>")]
    pub struct Widget {
        #[template_child(id = "label")]
        pub label: TemplateChild<gtk::Label>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Widget {
        const NAME: &'static str = "LinkAssistMacroTest";
        type Type = super::Widget;
        type ParentType = gtk::Box;

        fn class_init(klass: &mut Self::Class) {
            Self::bind_template(klass);
        }

        fn instance_init(obj: &glib::subclass::InitializingObject<Self>) {
            obj.init_template();
        }
    }

    impl ObjectImpl for Widget {}
    impl WidgetImpl for Widget {}
    impl ContainerImpl for Widget {}
    impl BoxImpl for Widget {}
}

glib::wrapper! {
    pub struct Widget(ObjectSubclass<imp::Widget>) @extends gtk::Widget, gtk::Container, gtk::Box;
}

#[test]
fn generated_template_bindings_compile_without_a_display() {
    // The test binary type-checks the full expansion. No display or GTK init is
    // needed because no widget is created and no native template code is run.
    assert!(std::mem::size_of::<imp::Widget>() > 0);
}
