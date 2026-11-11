#---------------------------------------------------------------------------------
# Joy-Con Bridge - Wii Homebrew (devkitPPC + libogc)
#---------------------------------------------------------------------------------
.SUFFIXES:

ifeq ($(strip $(DEVKITPPC)),)
$(error "Please set DEVKITPPC in your environment. export DEVKITPPC=<path to>devkitPPC")
endif

include $(DEVKITPPC)/wii_rules

#---------------------------------------------------------------------------------
TARGET		:=	boot
BUILD		:=	build
SOURCES		:=	source
DATA		:=
INCLUDES	:=	source

#---------------------------------------------------------------------------------
CFLAGS		=	-g -O2 -Wall -std=gnu11 $(MACHDEP) $(INCLUDE)
CXXFLAGS	=	$(CFLAGS)
LDFLAGS		=	-g $(MACHDEP) -Wl,-Map,$(notdir $@).map

LIBS		:=	-lfat -lwiiuse -lbte -logc -lm
LIBDIRS		:=	$(PORTLIBS)

#---------------------------------------------------------------------------------
ifneq ($(BUILD),$(notdir $(CURDIR)))
#---------------------------------------------------------------------------------

export OUTPUT	:=	$(CURDIR)/$(TARGET)
export VPATH	:=	$(foreach dir,$(SOURCES),$(CURDIR)/$(dir)) \
			$(foreach dir,$(DATA),$(CURDIR)/$(dir))
export DEPSDIR	:=	$(CURDIR)/$(BUILD)

CFILES		:=	$(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
export LD	:=	$(CC)
export OFILES	:=	$(CFILES:.c=.o)
export INCLUDE	:=	$(foreach dir,$(INCLUDES), -iquote $(CURDIR)/$(dir)) \
			$(foreach dir,$(LIBDIRS),-I$(dir)/include) \
			-I$(CURDIR)/$(BUILD) \
			-I$(LIBOGC_INC)
export LIBPATHS	:=	-L$(LIBOGC_LIB) $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

.PHONY: $(BUILD) clean run dist

$(BUILD):
	@[ -d $@ ] || mkdir -p $@
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile

clean:
	@echo clean ...
	@rm -fr $(BUILD) $(OUTPUT).elf $(OUTPUT).dol dist

run:
	wiiload $(TARGET).dol

# SD card layout for the Homebrew Channel: dist/apps/joycon-bridge/
dist: $(BUILD)
	@mkdir -p dist/apps/joycon-bridge
	@cp $(OUTPUT).dol meta.xml icon.png dist/apps/joycon-bridge/
	@echo "SD-Karten-Ordner: dist/apps/joycon-bridge"

#---------------------------------------------------------------------------------
else

DEPENDS	:=	$(OFILES:.o=.d)

$(OUTPUT).dol: $(OUTPUT).elf
$(OUTPUT).elf: $(OFILES)

-include $(DEPENDS)

#---------------------------------------------------------------------------------
endif
#---------------------------------------------------------------------------------
